import { db } from "./firebase.js";
import { doc, getDoc, setDoc, updateDoc, arrayUnion, increment } from "firebase/firestore";
import Papa from 'papaparse';


// ========================
// CONFIGURATION CONSTANTS
// ========================
// Number of brand-new words to include in each batch
const NEW_BATCH_SIZE = 50;
// Number of review words (mixed difficulty) to include in each batch
const MIX_SIZE = 50;
// Threshold for considering a word "mastered" without ever clicking it
const MASTER_THRESHOLD = 20;      
// Threshold for considering a word "mastered" after clicking
const REVIEW_THRESHOLD = 20;      

// ========================
// HELPER FUNCTIONS
// ========================

/**
 * Randomly picks up to n elements from an array without repeats.
 * @param {Array} arr - Source array
 * @param {number} n - Number to pick
 * @returns {Array} - Random subset
 */
function pickRandom(arr, n) {
  const copy = [...arr];
  const picked = [];
  while (picked.length < n && copy.length) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return picked;
}

/**
 * Selects 100 words for spaced repetition based on five categories:
 * 1. unseen (never shown)
 * 2. seen but unclicked (shown < MASTER_THRESHOLD times, never clicked)
 * 3. clicked-in-learning (clicked, but exposures since last click < REVIEW_THRESHOLD)
 * 4. mastered by repetition (shown >= MASTER_THRESHOLD, never clicked)
 * 5. mastered by review (clicked, exposures since last click >= REVIEW_THRESHOLD)
 * 
 * Always excludes mastered words from the selection.
 * Prioritizes: Unseen → Seen-unclicked → Clicked-in-learning
 */
function selectSpacedRepetitionWords(allWords, storyUsage = {}, clickCount = {}, lastClickUsage = {}) {
  // 1️⃣ Categorize words based on usage and click stats
  const unseen = allWords.filter(w => (storyUsage[w] || 0) === 0);
  const seenUnclicked = allWords.filter(w =>
    (storyUsage[w] || 0) > 0 && storyUsage[w] < MASTER_THRESHOLD && (clickCount[w] || 0) === 0
  );
  const clickedInLearning = allWords.filter(w =>
    (clickCount[w] || 0) > 0 && (storyUsage[w] - (lastClickUsage[w] || 0)) < REVIEW_THRESHOLD
  );
  const masteredByRepetition = allWords.filter(w =>
    (storyUsage[w] || 0) >= MASTER_THRESHOLD && (clickCount[w] || 0) === 0
  );
  const masteredByReview = allWords.filter(w =>
    (clickCount[w] || 0) > 0 && (storyUsage[w] - (lastClickUsage[w] || 0)) >= REVIEW_THRESHOLD
  );

  // 📊 Log category counts for your review
  console.log(`Unseen: ${unseen.length}, Seen-Unclicked: ${seenUnclicked.length}, Clicked-In-Learning: ${clickedInLearning.length}, Mastered (Rep): ${masteredByRepetition.length}, Mastered (Review): ${masteredByReview.length}`);

  // 2️⃣ Remove mastered words from further available options
  const available = allWords.filter(w =>
    !masteredByRepetition.includes(w) && !masteredByReview.includes(w)
  );

  // 3️⃣ Pick brand-new words (50 ideally)
  const batchNew = pickRandom(unseen, Math.min(unseen.length, NEW_BATCH_SIZE));

  // 4️⃣ Prepare review candidates (sort Clicked-in-Learning by clickCount ascending)
  const sortedClicked = clickedInLearning.sort((a, b) =>
    (clickCount[a] || 0) - (clickCount[b] || 0)
  );
  const third = Math.ceil(sortedClicked.length / 3);
  const hard   = sortedClicked.slice(0, third);
  const medium = sortedClicked.slice(third, 2 * third);
  const easy   = sortedClicked.slice(2 * third);

  // 5️⃣ Pick review words: 20 Hard, 20 Medium, 10 Easy (as per MIX_SIZE split)
  const hardPick   = pickRandom(hard,   Math.min(hard.length,   20));
  const mediumPick = pickRandom(medium, Math.min(medium.length, 20));
  const easyPick   = pickRandom(easy,   Math.min(easy.length,   10));

  // 6️⃣ Combine new + review picks
  let selectedWords = [...batchNew, ...hardPick, ...mediumPick, ...easyPick];

  // 7️⃣ If total is < 100, fill remaining with fallback precedence:
  // Unseen → Seen-Unclicked → Clicked-in-Learning (rest) → optionally mastered
  if (selectedWords.length < 100) {
    const remaining = 100 - selectedWords.length;

    // Fallback pool in order of precedence
    const fallbackPool = [
      ...unseen.filter(w => !selectedWords.includes(w)),
      ...seenUnclicked.filter(w => !selectedWords.includes(w)),
      ...clickedInLearning.filter(w => !selectedWords.includes(w))
    ];

    // Add remaining words from fallback pool
    selectedWords = [
      ...selectedWords,
      ...pickRandom(fallbackPool, Math.min(fallbackPool.length, remaining))
    ];
  }

  // 8️⃣ Return final batch (might still be < 100 if pool is too small)
  return selectedWords;
}


// ========================
// UPLOAD WORDS HANDLER
// ========================
// Reads an uploaded text file, normalizes special chars, splits into words,
// deduplicates, and stores unique entries in Firestore 'wordBank'.

document.getElementById('uploadWords').addEventListener('click', async () => {
  try {
    const fileInput = document.getElementById('wordFile');
    const file = fileInput.files[0];
    if (!file) {
      alert('Please select a file first.');
      return;
    }

    const fileExt = file.name.split('.').pop().toLowerCase();
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buffer);

    let newWords = [];

    if (fileExt === 'csv') {
      Papa.parse(text, {
        delimiter: ";",  // or "," — adjust this as needed
        header: false,
        skipEmptyLines: true,
        complete: function(results) {
          newWords = results.data.flat().map(w => w.trim()).filter(w => w.length > 0);
          uploadToFirestore(newWords);  // Call your Firestore function here
        },
        error: function(err) {
          console.error("CSV parsing error:", err);
          alert(`CSV parsing error: ${err.message}`);
        }
      });
    } else if (fileExt === 'txt') {
      // Remove BOM if present
      let cleanText = text;
      if (cleanText.charCodeAt(0) === 0xFEFF) cleanText = cleanText.slice(1);
      cleanText = cleanText.normalize('NFC');

      newWords = cleanText
        .split(/\r?\n|[,;|]+/)
        .map(w => w.trim())
        .filter(w => w.length > 0);

      await uploadToFirestore(newWords);  // Call your Firestore function here

    } else {
      alert('Unsupported file type. Please upload a .txt or .csv file.');
    }

  } catch (e) {
    console.error('Upload error:', e);
    alert(`Error: ${e.message}`);
  }
});

async function uploadToFirestore(newWords) {
  const wordBankRef = doc(db, 'meta', 'wordBank');
  const wordBankSnap = await getDoc(wordBankRef);

  if (wordBankSnap.exists()) {
    const existing = wordBankSnap.data().words || [];
    const unique = newWords.filter(w => !existing.includes(w));
    if (!unique.length) {
      alert('All words already exist.');
      return;
    }
    await updateDoc(wordBankRef, { words: arrayUnion(...unique) });
    alert(`${unique.length} new words added!`);
  } else {
    await setDoc(wordBankRef, { words: newWords });
    alert(`Word bank created with ${newWords.length} words!`);
  }
}



// ========================
// FETCH & GENERATE STORY HANDLER
// ========================
// Retrieves wordBank + stats, selects 100 words, updates usage counts,
// and calls generateStory()

document.getElementById('fetchWords').addEventListener('click', async () => {
  try {
    // Load master word list
    const wordBankSnap = await getDoc(doc(db, 'meta', 'wordBank'));
    if (!wordBankSnap.exists()) return alert('Upload words first.');

    const allWords = (wordBankSnap.data().words || [])
      .map(w => typeof w === 'string' ? w.normalize('NFKC') : '')
      .filter(w => w.length);

    // Load or initialize stats
    const statsRef = doc(db, 'meta', 'wordStats');
    const statsSnap = await getDoc(statsRef);
    const stats = statsSnap.exists() ? statsSnap.data() : {};
    const storyUsage     = stats.storyUsage     || {};
    const clickCount     = stats.clickCount     || {};
    const lastClickUsage = stats.lastClickUsage || {};

    // Ensure enough words available
    if (allWords.length < NEW_BATCH_SIZE + MIX_SIZE) {
      return alert(`Need at least ${NEW_BATCH_SIZE + MIX_SIZE} words (have ${allWords.length}).`);
    }

    // Select 100 words based on spaced repetition logic
    const selected = selectSpacedRepetitionWords(allWords, storyUsage, clickCount, lastClickUsage);

    // Increment storyUsage for each selected word
    const usageUpdates = selected.reduce((acc, w) => ({
      ...acc,
      [`storyUsage.${w}`]: increment(1)
    }), {});
    if (statsSnap.exists()) await updateDoc(statsRef, usageUpdates);
    else await setDoc(statsRef, { storyUsage: selected.reduce((o, w) => ({ ...o, [w]: 1 }), {}), clickCount: {}, lastClickUsage: {} });

    // Show loading message, then generate and display story
    document.getElementById('story').innerText = "Generating story...";
    const story = await generateStory(selected);
    displaySelectableStory(story);

  } catch (e) {
    console.error('Fetch error:', e);
    document.getElementById('story').innerText = `Error: ${e.message}`;
  }
});

// ========================
// GEMINI STORY GENERATION FUNCTION
// ========================
// Sends a POST request to Google Gemini API with a prompt using only selected words

async function generateStory(words) {
  try {
    const key = import.meta.env.VITE_GEMINI_API_KEY;
    if (!key) throw new Error('API key missing');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
    const prompt = `Write a short, meaningful and coherent story in present tense in German. You are only allowed to use the following 
                  words: ${words.join(', ')}. Do not include any other words outside this list. The story should 
                  be 13 lines and in 2 passages. It should read like a story, not some bundled up sentences.
                  Important: Use correct German spelling, including umlauts (ä, ö, ü, ß).`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No story generated.";
  } catch (e) {
    console.error('API error:', e);
    return `Error: ${e.message}`;
  }
}

// ========================
// UTILITY: Strip punctuation from a word
// ========================
function sanitizeWord(word) {
  return word.replace(/[\p{P}\p{S}]+/gu, "").trim();
}

// ========================
// DISPLAY STORY FUNCTION (updated)
// ========================
function displaySelectableStory(text) {
  const cont = document.getElementById('story');
  cont.innerHTML = '';
  cont.style.whiteSpace = 'normal';
  cont.style.overflowWrap = 'anywhere';
  cont.style.wordBreak = 'break-word';

  // Split on whitespace but retain punctuation on the span text
  text.split(/(\s+)/).forEach(token => {
    if (!token.trim()) {
      // whitespace: add as text node
      cont.appendChild(document.createTextNode(token));
    } else {
      // word or punctuation
      const s = document.createElement('span');
      s.innerText = token;
      s.style.cursor = 'pointer';
      s.style.userSelect = 'none';
      s.style.padding = '2px 4px';
      s.style.borderRadius = '4px';
      
      s.addEventListener('click', () => {
        // sanitize before sending to database
        const clicked = sanitizeWord(token);
        if (clicked) handleWordClick(clicked);
      });
      s.addEventListener('mouseover', () => s.style.backgroundColor = '#eef');
      s.addEventListener('mouseout', () => s.style.backgroundColor = '');
      cont.appendChild(s);
    }
  });
}

// ========================
// HANDLE WORD CLICK FUNCTION (updated)
// ========================
async function handleWordClick(rawWord) {
  const word = sanitizeWord(rawWord);
  if (!word) return;  // nothing to do if only punctuation

  const statsRef = doc(db, 'meta', 'wordStats');
  const statsSnap = await getDoc(statsRef);
  const stats = statsSnap.exists() ? statsSnap.data() : {};
  const storyUsage = stats.storyUsage || {};

  try {
    await updateDoc(statsRef, {
      // bump click count by 1
      [`clickCount.${word}`]: increment(1),
      // record current usage count as "last clicked at"
      [`lastClickUsage.${word}`]: storyUsage[word] || 0
    });
    console.log(`✅ Clicked: ${word}`);
  } catch (e) {
    if (e.code === 'not-found') {
      // initialize stats doc if missing
      await setDoc(statsRef, {
        storyUsage: {},
        clickCount: { [word]: 1 },
        lastClickUsage: { [word]: storyUsage[word] || 0 }
      });
      console.log(`✅ Created stats and set click for ${word}`);
    } else console.error('Click error:', e);
  }
}


