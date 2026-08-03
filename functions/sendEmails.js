const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { enviarPush } = require('./sendPush');

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
        .map(doc => doc.data())
        .filter(u => u.ativo && u.email)
        .map(u => u.email);

      const resumo = atrasados
        .map(eq => `${eq.patrimonio} - ${eq.ambiente} (Agendado: ${eq.dataAgendada})`)
        .join('\n');

      if (emails.length > 0) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emails.join(','),
            subject: `PMOK ALECE - Alerta: ${atrasados.length} equipamento(s) atrasado(s)`,
            html: `
              <h2>Alerta de Manutenção Atrasada</h2>
              <p>Existem ${atrasados.length} equipamentos com manutenção atrasada:</p>
              <pre>${resumo}</pre>
              <p><a href="https://seu-dominio.com/pcm-alece">Acesse o PMOK ALECE</a></p>
            `,
          });
          console.log(`Email de alerta enviado para ${emails.length} destinatários`);
        } catch (error) {
          console.error('Erro ao enviar email:', error);
        }
      }

      try {
        await enviarPush(
          db,
          usuariosSnap,
          'PMOK ALECE',
          `${atrasados.length} equipamento(s) com manutenção atrasada.`
        );
      } catch (error) {
        console.error('Erro ao enviar push:', error);
      }
    } catch (error) {
      console.error('Erro ao processar alerta de atrasados:', error);
    }
  });

function celula(conteudo, destaque) {
  const fundo = destaque ? '#f0f0f0' : '#fff';
  return `<td style="border: 1px solid #ccc; padding: 8px 10px; background: ${fundo};">${conteudo}</td>`;
}

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
      if (equipamentos.length === 0) return;

      const usuariosSnap = await db.collection('usuarios').get();
      const emails = usuariosSnap.docs
        .map(doc => doc.data())
        .filter(u => u.ativo && u.email)
        .map(u => u.email);

      const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
      const andamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
      const pendentes = equipamentos.length - concluidas - andamento;
      const execucao = (concluidas / equipamentos.length * 100).toFixed(1);

      const hoje = new Date();
      const hojeISO = hoje.toISOString().split('T')[0];

      const seteDiasAtras = new Date(hoje);
      seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
      const seteDiasAtrasISO = seteDiasAtras.toISOString();

      const seteDiasFrente = new Date(hoje);
      seteDiasFrente.setDate(seteDiasFrente.getDate() + 7);
      const seteDiasFrenteISO = seteDiasFrente.toISOString().split('T')[0];

      const historicoSnap = await db
        .collection('ciclos')
        .doc(cicloId)
        .collection('historico')
        .where('registradoEm', '>=', seteDiasAtrasISO)
        .get();
      const concluidasSemana = historicoSnap.docs
        .filter(doc => doc.data().statusNovo === 'Concluída').length;

      const atrasados = equipamentos
        .filter(e => e.dataAgendada < hojeISO && e.statusPreventiva !== 'Concluída')
        .sort((a, b) => (a.dataAgendada || '').localeCompare(b.dataAgendada || ''));

      const proximos = equipamentos
        .filter(e => e.dataAgendada >= hojeISO && e.dataAgendada <= seteDiasFrenteISO && e.statusPreventiva !== 'Concluída')
        .sort((a, b) => (a.dataAgendada || '').localeCompare(b.dataAgendada || ''));

      const porSetor = {};
      equipamentos.forEach(e => {
        const setor = e.setorPCM || 'Não classificado';
        if (!porSetor[setor]) porSetor[setor] = [];
        porSetor[setor].push(e);
      });

      const linhasSetor = Object.entries(porSetor).map(([setor, itens]) => {
        const setorConcluidas = itens.filter(e => e.statusPreventiva === 'Concluída').length;
        const setorAndamento = itens.filter(e => e.statusPreventiva === 'Em andamento').length;
        const setorPendentes = itens.length - setorConcluidas - setorAndamento;
        const setorProgresso = (setorConcluidas / itens.length * 100).toFixed(0);
        return `<tr>${celula(setor)}${celula(itens.length)}${celula(setorConcluidas)}${celula(setorAndamento)}${celula(setorPendentes)}${celula(setorProgresso + '%')}</tr>`;
      }).join('');

      const LIMITE_LISTA = 20;
      const linhasAtrasados = atrasados.slice(0, LIMITE_LISTA).map(eq =>
        `<tr>${celula(eq.patrimonio || '-')}${celula(eq.setor || '-')}${celula(eq.ambiente || '-')}${celula(eq.dataAgendada || '-')}</tr>`
      ).join('');
      const notaAtrasados = atrasados.length > LIMITE_LISTA
        ? `<p style="font-size:12px;color:#666">E mais ${atrasados.length - LIMITE_LISTA} equipamento(s) atrasado(s).</p>` : '';

      const linhasProximos = proximos.slice(0, LIMITE_LISTA).map(eq =>
        `<tr>${celula(eq.patrimonio || '-')}${celula(eq.setor || '-')}${celula(eq.ambiente || '-')}${celula(eq.dataAgendada || '-')}</tr>`
      ).join('');
      const notaProximos = proximos.length > LIMITE_LISTA
        ? `<p style="font-size:12px;color:#666">E mais ${proximos.length - LIMITE_LISTA} equipamento(s) agendado(s).</p>` : '';

      const th = 'style="border: 1px solid #ccc; padding: 8px 10px; background: #1F4E78; color: #fff; text-align:left; font-size:12px;"';

      if (emails.length > 0) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: emails.join(','),
            subject: 'PMOK ALECE - Relatório Semanal de Manutenção',
            html: `
          <h2>Relatório Semanal - PMOK ALECE</h2>
          <p style="color:#666;font-size:12px">Gerado em ${hoje.toLocaleDateString('pt-BR')}</p>

          <h3>Visão geral</h3>
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
            <tr>${celula('Total de Equipamentos')}${celula(equipamentos.length)}</tr>
            <tr>${celula('Concluídas')}${celula(concluidas)}</tr>
            <tr>${celula('Em Andamento')}${celula(andamento)}</tr>
            <tr>${celula('Pendentes')}${celula(pendentes)}</tr>
            <tr>${celula('Concluídas nos últimos 7 dias')}${celula(concluidasSemana)}</tr>
            <tr>${celula('Taxa de Execução Geral', true)}${celula(execucao + '%', true)}</tr>
          </table>

          <h3>Resumo por setor</h3>
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
            <tr><th ${th}>Setor</th><th ${th}>Total</th><th ${th}>Concluídas</th><th ${th}>Em Andamento</th><th ${th}>Pendentes</th><th ${th}>Progresso</th></tr>
            ${linhasSetor}
          </table>

          <h3>Equipamentos atrasados (${atrasados.length})</h3>
          ${atrasados.length > 0 ? `
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 4px;">
            <tr><th ${th}>Patrimônio</th><th ${th}>Setor</th><th ${th}>Ambiente</th><th ${th}>Data Agendada</th></tr>
            ${linhasAtrasados}
          </table>
          ${notaAtrasados}` : '<p>Nenhum equipamento atrasado no momento.</p>'}

          <h3 style="margin-top:20px">Agenda dos próximos 7 dias (${proximos.length})</h3>
          ${proximos.length > 0 ? `
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 4px;">
            <tr><th ${th}>Patrimônio</th><th ${th}>Setor</th><th ${th}>Ambiente</th><th ${th}>Data Agendada</th></tr>
            ${linhasProximos}
          </table>
          ${notaProximos}` : '<p>Nenhum equipamento agendado para os próximos 7 dias.</p>'}

          <p style="margin-top:20px"><a href="https://seu-dominio.com/pcm-alece">Acessar Dashboard</a></p>
            `,
          });
          console.log(`Relatório semanal enviado para ${emails.length} destinatários`);
        } catch (error) {
          console.error('Erro ao enviar relatório por email:', error);
        }
      }

      try {
        await enviarPush(
          db,
          usuariosSnap,
          'PMOK ALECE',
          `Relatório semanal: ${concluidas}/${equipamentos.length} concluídos (${execucao}%). ${atrasados.length} atrasado(s).`
        );
      } catch (error) {
        console.error('Erro ao enviar push:', error);
      }
    } catch (error) {
      console.error('Erro ao processar relatório semanal:', error);
    }
  });
