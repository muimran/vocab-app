import { db } from "./firebase.js";
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from "firebase/firestore";

// ========================
// UPLOAD WORDS (FIXED FOR SPECIAL CHARACTERS)
// ========================
document.getElementById('uploadWords').addEventListener('click', async () => {
  try {
    const fileInput = document.getElementById('wordFile');
    const file = fileInput.files[0];
    if (!file) {
      alert('Please select a file first.');
      return;
    }

    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file, 'UTF-8');
    });

    const newWords = text
      .normalize('NFKC')
      .split(/[\r\n,;|]+/)
      .map(word => word.trim())
      .filter(word => word.length > 0);

    console.log("First 10 words:", newWords.slice(0, 10));

    const hasSpecialChars = newWords.some(word => /[äöüß]/i.test(word));
    console.log(hasSpecialChars ? "✅ Special characters detected" : "⚠️ No special characters found");

    if (newWords.length === 0) {
      alert('No valid words found. Separate words with line breaks or commas.');
      return;
    }

    const wordBankRef = doc(db, 'meta', 'wordBank');
    const wordBankSnap = await getDoc(wordBankRef);

    if (wordBankSnap.exists()) {
      const existingWords = wordBankSnap.data().words || [];
      const uniqueNewWords = newWords.filter(word => !existingWords.includes(word));
      if (uniqueNewWords.length === 0) {
        alert('All words already exist in the word bank.');
        return;
      }
      await updateDoc(wordBankRef, {
        words: arrayUnion(...uniqueNewWords)
      });
      alert(`${uniqueNewWords.length} new words added! Total: ${existingWords.length + uniqueNewWords.length}`);
    } else {
      await setDoc(wordBankRef, { words: newWords });
      alert(`New word list created with ${newWords.length} words!`);
    }
  } catch (error) {
    console.error('Upload error:', error);
    alert(`Error: ${error.message}`);
  }
});

// ========================
// FETCH WORDS AND GENERATE STORY
// ========================
document.getElementById('fetchWords').addEventListener('click', async () => {
  try {
    const wordBankRef = doc(db, 'meta', 'wordBank');
    const wordBankSnap = await getDoc(wordBankRef);
    if (!wordBankSnap.exists()) {
      alert('No word bank found. Please upload words first.');
      return;
    }

    const wordsArray = (wordBankSnap.data().words || [])
      .map(word => typeof word === 'string' ? word.normalize('NFKC') : '')
      .filter(word => word.length > 0);

    console.log('Total words:', wordsArray.length);

    const specialCharWords = wordsArray.filter(word => /[äöüß]/i.test(word));
    console.log('Words with special characters:', specialCharWords.slice(0, 10));

    if (wordsArray.length < 100) {
      alert(`Minimum 100 words required (currently: ${wordsArray.length}).`);
      return;
    }

    const randomWords = [...wordsArray]
      .sort(() => 0.5 - Math.random())
      .slice(0, 100);

    document.getElementById('story').innerText = "Generating story...";
    const story = await generateStory(randomWords);

    displaySelectableStory(story);

  } catch (error) {
    console.error('Error:', error);
    document.getElementById('story').innerText = `Error: ${error.message}`;
  }
});

// ========================
// GEMINI STORY GENERATION
// ========================
async function generateStory(words) {
  try {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) throw new Error('API key missing');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const prompt = `Write a short, meaningful and coherent story in present tense in German. You are only allowed to use the following 
                  words: ${words.join(', ')}. Do not include any other words outside this list. The story should 
                  be 13 lines and in 2 passages. It should read like a story, not some bundled up sentences.
                  Important: Use correct German spelling, including umlauts (ä, ö, ü, ß) wherever appropriate.`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No story generated.";
  } catch (error) {
    console.error('API error:', error);
    return `Error: ${error.message}`;
  }
}

// ========================
// DISPLAY STORY WITH SELECTABLE WORDS
// ========================
function displaySelectableStory(storyText) {
  const storyContainer = document.getElementById('story');
  storyContainer.innerHTML = "";

  // Split story by spaces and wrap each word in a <span>
  const words = storyText.split(/\s+/);

  words.forEach((word, index) => {
    const span = document.createElement('span');
    span.innerText = word + " ";
    span.style.cursor = 'pointer';
    span.style.userSelect = 'none';
    span.style.padding = '2px 4px';
    span.style.borderRadius = '4px';
    span.addEventListener('click', () => handleWordClick(word));
    span.addEventListener('mouseover', () => {
      span.style.backgroundColor = '#eef';
    });
    span.addEventListener('mouseout', () => {
      span.style.backgroundColor = '';
    });
    storyContainer.appendChild(span);
  });
}

// ========================
// HANDLE WORD CLICK
// ========================
async function handleWordClick(word) {
  try {
    const wordClicksRef = doc(db, 'meta', 'wordClicks');
    await updateDoc(wordClicksRef, {
      clicks: arrayUnion(word)
    });
    console.log(`✅ Word clicked: ${word}`);
  } catch (error) {
    if (error.code === 'not-found') {
      await setDoc(doc(db, 'meta', 'wordClicks'), { clicks: [word] });
      console.log(`✅ Word click document created and word logged: ${word}`);
    } else {
      console.error('Click logging error:', error);
    }
  }
}
