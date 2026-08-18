# Clube do Livro ♥

Diário de leitura para duas pessoas, com módulos de biblioteca, diário, respostas secretas, discussão, estatísticas, premiações, memórias e personalização.

---

## Como rodar

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar o Firebase

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
2. Crie um projeto (ou use o existente)
3. Vá em **Project Settings → Your apps → Web app**
4. Copie as credenciais e cole no arquivo `.env.local`:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

5. No Firebase Console, vá em **Firestore Database → Create database** (modo teste por enquanto)

### 3. Rodar em desenvolvimento
```bash
npm run dev
```

Acesse: http://localhost:3000

### 4. Deploy (Vercel — recomendado)
```bash
npm install -g vercel
vercel
```
Configure as variáveis de ambiente no painel da Vercel.

---

## Estrutura do Firestore

```
config/
  app                    ← configurações globais (nome do clube, citação, livroAtualId)

livros/
  {livroId}/
    titulo, autor, capa, sinopse, status, notas...
    capitulos/
      {numero}/
        impressao_jovanna, impressao_leticia
        emocoes_jovanna, emocoes_leticia
        frase_jovanna, frase_leticia
        teoria_jovanna, teoria_leticia
        jovanna_enviou, leticia_enviou
        comentarios/
          {id}/  ← mensagens da discussão

premiacoes/
  {livroId}/             ← melhor personagem, cena favorita, etc.
```

---

## Módulos

| Módulo | Descrição |
|--------|-----------|
| 📚 Biblioteca | Livros planejados, lendo e concluídos |
| ✍️ Diário | Impressões, emoções e frases por capítulo |
| 🔒 Secreto | Teorias bloqueadas até ambas enviarem |
| 💬 Discussão | Chat por capítulo (liberado após revelação) |
| 📊 Estatísticas | Notas, sugestões, gêneros favoritos |
| 🏆 Premiações | Melhor personagem, cena, teoria mais maluca |
| 💌 Memórias | Página memorial de cada livro concluído |
| ⚙️ Config | Nome do clube, citação, cartas do futuro, notas |
