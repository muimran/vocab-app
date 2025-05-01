import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyDwiENl4UYBXVU2Hs-UR8X0J3QOYXP4fro",
    authDomain: "vocabapp-105be.firebaseapp.com",
    projectId: "vocabapp-105be",
    storageBucket: "vocabapp-105be.firebasestorage.app",
    messagingSenderId: "510549747096",
    appId: "1:510549747096:web:fce965c86242ad21b7b7ed"
  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };
