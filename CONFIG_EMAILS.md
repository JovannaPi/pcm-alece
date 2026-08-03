Configuração de Notificações por Email

FUNCIONALIDADES IMPLEMENTADAS

1. Alertas Automáticos de Equipamentos Atrasados
   - Enviados diariamente às 8h (horário de Fortaleza)
   - Mostra equipamentos com manutenção atrasada
   - Enviado para todos os usuários com email de notificação cadastrado e ativo

2. Relatório Semanal por Email
   - Enviado toda segunda-feira às 9h
   - Visão geral: total, concluídas, em andamento, pendentes, concluídas nos
     últimos 7 dias e taxa de execução geral
   - Resumo por setor (total, concluídas, em andamento, pendentes, progresso)
   - Lista de equipamentos atrasados (até 20, com contagem do restante)
   - Agenda dos próximos 7 dias (até 20, com contagem do restante)

3. Relatório em PDF (sob demanda)
   - Botão "Baixar relatório (PDF)" na aba Dashboard
   - Inclui KPIs, resumo por setor e equipamentos atrasados

PASSO A PASSO — CONFIGURAR O ENVIO DE EMAIL

1. Instale o Firebase CLI (se ainda não tiver):
   npm install -g firebase-tools

2. Faça login:
   firebase login

3. Na raiz do projeto, confirme que o projeto Firebase certo está selecionado:
   firebase use --add

4. Gere uma Senha de App do Gmail (não use a senha normal da conta):
   https://myaccount.google.com/apppasswords
   (exige verificação em duas etapas ativada na conta Google)

5. Crie o arquivo de variáveis de ambiente DENTRO da pasta functions/
   (não na raiz do projeto — é isso que o Firebase carrega automaticamente
   nas Cloud Functions):

   functions/.env
   EMAIL_USER=seu-email@gmail.com
   EMAIL_PASSWORD=senha-de-app-gerada-no-passo-4

   Esse arquivo já está no .gitignore — nunca commite ele.

6. Instale as dependências das functions:
   cd functions
   npm install
   cd ..

7. Publique as Cloud Functions:
   firebase deploy --only functions

CADASTRAR QUEM RECEBE OS EMAILS

Vá em Configurações > Usuários > Criar nova conta. Existe um campo
"Email para notificações" — preencha com um email real (ex: gmail,
institucional). Só quem tiver esse campo preenchido recebe os alertas
automáticos e o relatório semanal. Contas antigas, criadas antes dessa
mudança, não têm email cadastrado — edite-as ou recrie-as para começar a
receber notificações.

TESTAR SEM ESPERAR O HORÁRIO AGENDADO

No Firebase Console > Functions, você pode disparar manualmente uma função
agendada clicando em "Testar função" ou usando:
firebase functions:shell
depois, dentro do shell interativo:
enviarAlertaAtrasados()
enviarRelatoriSemanal()

SUPORTE

Problemas comuns:

1. "Email não foi enviado"
   - Verifique se functions/.env existe e tem EMAIL_USER e EMAIL_PASSWORD
   - Confirme que gerou uma Senha de App (não a senha normal do Gmail)
   - Veja os logs: firebase functions:log

2. "Ninguém recebeu o email, mas rodou sem erro"
   - Verifique se algum usuário na coleção "usuarios" tem o campo "email"
     preenchido e "ativo": true

3. "PDF está vazio ou não baixa"
   - Há dados em ESTADO.equipamentos?
   - html2pdf carregou no index.html?

PRÓXIMAS MELHORIAS

- Webhook para notificações em Slack
- Integração com Google Calendar
- Modo offline com sincronização
- Personalização de horários de notificação
