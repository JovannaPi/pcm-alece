importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDlXUNfjDlmvOWxlgVRgJeyMQ2ntD7qxJg",
  authDomain: "pcm-alece.firebaseapp.com",
  projectId: "pcm-alece",
  storageBucket: "pcm-alece.firebasestorage.app",
  messagingSenderId: "414503646531",
  appId: "1:414503646531:web:15e48ab67891a093362bf6",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const titulo = (payload.notification && payload.notification.title) || "PMOK ALECE";
  const corpo = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(titulo, {
    body: corpo,
    icon: "/site-header-mobile.png",
  });
});
