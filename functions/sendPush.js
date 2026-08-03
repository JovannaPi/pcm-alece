const admin = require('firebase-admin');

async function enviarPush(db, usuariosSnap, titulo, corpo) {
  const tokenOwners = [];
  usuariosSnap.docs.forEach(doc => {
    (doc.data().fcmTokens || []).forEach(token => {
      if (token) tokenOwners.push({ uid: doc.id, token });
    });
  });

  if (tokenOwners.length === 0) return;

  const response = await admin.messaging().sendEachForMulticast({
    tokens: tokenOwners.map(t => t.token),
    notification: { title: titulo, body: corpo },
  });

  const remocoes = [];
  response.responses.forEach((resp, i) => {
    if (!resp.success && resp.error && resp.error.code === 'messaging/registration-token-not-registered') {
      remocoes.push(
        db.collection('usuarios').doc(tokenOwners[i].uid).update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(tokenOwners[i].token),
        })
      );
    }
  });
  if (remocoes.length > 0) await Promise.all(remocoes);

  console.log(`Push enviado para ${tokenOwners.length} dispositivo(s)`);
}

module.exports = { enviarPush };
