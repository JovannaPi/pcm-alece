const admin = require('firebase-admin');
const { enviarAlertaAtrasados, enviarRelatoriSemanal } = require('./sendEmails');

admin.initializeApp();

exports.enviarAlertaAtrasados = enviarAlertaAtrasados;
exports.enviarRelatoriSemanal = enviarRelatoriSemanal;
