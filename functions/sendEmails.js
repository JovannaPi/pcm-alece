const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

exports.enviarAlertaAtrasados = functions.pubsub
  .schedule('0 8 * * *')
  .timeZone('America/Fortaleza')
  .onRun(async (context) => {
    try {
      const db = admin.firestore();

      const ciclosSnap = await db.collection('ciclos')
        .orderBy('criadoEm', 'desc')
        .limit(1)
        .get();

      if (ciclosSnap.empty) return;

      const cicloId = ciclosSnap.docs[0].id;
      const equipamentosSnap = await db
        .collection('ciclos')
        .doc(cicloId)
        .collection('equipamentos')
        .where('statusPreventiva', '!=', 'Concluída')
        .get();

      const hoje = new Date().toISOString().split('T')[0];
      const atrasados = equipamentosSnap.docs
        .map(doc => doc.data())
        .filter(eq => eq.dataAgendada < hoje);

      if (atrasados.length === 0) return;

      const usuariosSnap = await db.collection('usuarios').get();
      const emails = usuariosSnap.docs
        .map(doc => doc.data().email)
        .filter(Boolean);

      const resumo = atrasados
        .map(eq => `${eq.patrimonio} - ${eq.ambiente} (Agendado: ${eq.dataAgendada})`)
        .join('\n');

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: emails.join(','),
        subject: `PMOK ALECE - Alerta: ${atrasados.length} equipamento(s) atrasado(s)`,
        html: `
          <h2>Alerta de Manutenção Atrasada</h2>
          <p>Existem ${atrasados.length} equipamentos com manutenção atrasada:</p>
          <pre>${resumo}</pre>
          <p><a href="https://seu-dominio.com/pcm-alece">Acesse o PMOK ALECE</a></p>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`Email de alerta enviado para ${emails.length} destinatários`);
    } catch (error) {
      console.error('Erro ao enviar email:', error);
    }
  });

exports.enviarRelatoriSemanal = functions.pubsub
  .schedule('0 9 * * 1')
  .timeZone('America/Fortaleza')
  .onRun(async (context) => {
    try {
      const db = admin.firestore();

      const ciclosSnap = await db.collection('ciclos')
        .orderBy('criadoEm', 'desc')
        .limit(1)
        .get();

      if (ciclosSnap.empty) return;

      const cicloId = ciclosSnap.docs[0].id;
      const equipamentosSnap = await db
        .collection('ciclos')
        .doc(cicloId)
        .collection('equipamentos')
        .get();

      const equipamentos = equipamentosSnap.docs.map(doc => doc.data());

      const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
      const andamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
      const pendentes = equipamentos.filter(e => e.statusPreventiva === 'Pendente').length;
      const execucao = ((concluidas + andamento) / equipamentos.length * 100).toFixed(1);

      const usuariosSnap = await db.collection('usuarios').get();
      const emails = usuariosSnap.docs
        .map(doc => doc.data().email)
        .filter(Boolean);

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: emails.join(','),
        subject: 'PMOK ALECE - Relatório Semanal de Manutenção',
        html: `
          <h2>Relatório Semanal - PMOK ALECE</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr style="background: #f0f0f0;">
              <td style="border: 1px solid #ccc; padding: 10px;">Métrica</td>
              <td style="border: 1px solid #ccc; padding: 10px;">Quantidade</td>
            </tr>
            <tr>
              <td style="border: 1px solid #ccc; padding: 10px;">Total de Equipamentos</td>
              <td style="border: 1px solid #ccc; padding: 10px;">${equipamentos.length}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #ccc; padding: 10px;">Concluídas</td>
              <td style="border: 1px solid #ccc; padding: 10px;">${concluidas}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #ccc; padding: 10px;">Em Andamento</td>
              <td style="border: 1px solid #ccc; padding: 10px;">${andamento}</td>
            </tr>
            <tr>
              <td style="border: 1px solid #ccc; padding: 10px;">Pendentes</td>
              <td style="border: 1px solid #ccc; padding: 10px;">${pendentes}</td>
            </tr>
            <tr style="background: #f0f0f0;">
              <td style="border: 1px solid #ccc; padding: 10px;"><strong>Taxa de Execução</strong></td>
              <td style="border: 1px solid #ccc; padding: 10px;"><strong>${execucao}%</strong></td>
            </tr>
          </table>
          <p><a href="https://seu-dominio.com/pcm-alece">Acessar Dashboard</a></p>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`Relatório semanal enviado para ${emails.length} destinatários`);
    } catch (error) {
      console.error('Erro ao enviar relatório:', error);
    }
  });
