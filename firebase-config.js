import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, enableMultiTabIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDlXUNfjDlmvOWxlgVRgJeyMQ2ntD7qxJg",
  authDomain: "pcm-alece.firebaseapp.com",
  projectId: "pcm-alece",
  storageBucket: "pcm-alece.firebasestorage.app",
  messagingSenderId: "414503646531",
  appId: "1:414503646531:web:15e48ab67891a093362bf6",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Guarda os dados e as escritas pendentes no IndexedDB do navegador. Sem
// isso, se o app recarregar ou fechar sem sinal (comum em casa de
// máquinas/subsolo), um "Salvar e concluir" que ainda não sincronizou se
// perde. "MultiTab" porque não dá pra garantir que a pessoa não vai abrir
// o sistema em mais de uma aba ao mesmo tempo (a variante de aba única
// trava com erro se isso acontecer).
enableMultiTabIndexedDbPersistence(db).catch((err) => {
  console.warn("Persistência offline não pôde ser ativada:", err.code);
});
