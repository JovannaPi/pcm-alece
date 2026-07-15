import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDlXUNfjDlmvOWxlgVRgJeyMQ2ntD7qxJg",
  authDomain: "pcm-alece.firebaseapp.com",
  projectId: "pcm-alece",
  storageBucket: "pcm-alece.firebasestorage.app",
  messagingSenderId: "414503646531",
  appId: "1:414503646531:web:15e48ab67891a093362bf6",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
