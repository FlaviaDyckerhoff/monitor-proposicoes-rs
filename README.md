# 🏛️ Monitor Proposições RS — ALRS

Monitora automaticamente a API da Assembleia Legislativa do Rio Grande do Sul e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script chama a API interna da ALRS (`ww4.al.rs.gov.br:5000/listaProposicaoCompleto`)
3. Compara as proposições recebidas com as já registradas no `estado.json`
4. Se há proposições novas → envia email com a lista organizada por tipo
5. Salva o estado atualizado no repositório

> **Nota sobre estabilidade:** A API da ALRS roda na porta 5000 e tem instabilidade ocasional.
> O script tenta até **3 vezes** com intervalo de 15s entre tentativas antes de desistir.
> Se falhar em todas, não atualiza o estado e tenta novamente na próxima execução.

---

## Estrutura do repositório

```
monitor-proposicoes-rs/
├── monitor.js                      # Script principal
├── package.json                    # Dependências (só nodemailer)
├── estado.json                     # Estado salvo automaticamente pelo workflow
├── README.md                       # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml             # Workflow do GitHub Actions
```

---

## Setup — Passo a Passo

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Procure por **"Senhas de app"** e clique.

**1.4** Digite um nome (ex: `monitor-alrs`) e clique em **Criar**.

**1.5** Copie a senha de **16 letras** gerada — ela só aparece uma vez.

> Se já fez isso para o monitor do PR, pode reutilizar a mesma senha de app.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **+ → New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-rs`
- **Visibility:** Private

**2.3** Clique em **Create repository**

---

### PARTE 3 — Fazer upload dos arquivos

**3.1** Na página do repositório, clique em **"uploading an existing file"**

**3.2** Faça upload de:
```
monitor.js
package.json
README.md
```
Clique em **Commit changes**.

**3.3** O `monitor.yml` precisa estar numa pasta específica. Clique em **Add file → Create new file**, digite:
```
.github/workflows/monitor.yml
```
Abra o arquivo `monitor.yml`, copie todo o conteúdo e cole. Clique em **Commit changes**.

---

### PARTE 4 — Configurar os Secrets

**4.1** No repositório: **Settings → Secrets and variables → Actions**

**4.2** Clique em **New repository secret** e crie os 3 secrets:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | a senha de 16 letras do App Password (sem espaços) |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

### PARTE 5 — Testar

**5.1** Vá em **Actions → Monitor Proposições RS → Run workflow → Run workflow**

**5.2** Aguarde ~30 segundos (pode demorar mais que o PR por causa das retentativas).

**5.3** Verde = funcionou. O primeiro run envia email com todas as proposições do ano e salva o estado.

**5.4** Se ficar amarelo/vermelho, abra o log e veja se há `⚠️ Tentativa X falhou` — pode ser instabilidade pontual da API da ALRS. Tente rodar novamente em alguns minutos.

---

## API utilizada

```
URL:    https://ww4.al.rs.gov.br:5000/listaProposicaoCompleto
Método: POST
Auth:   Nenhuma
Body:   JSON com filtros (ano, tipo, proponente, etc.)
```

Esta é a API interna usada pelo próprio site da ALRS. Não está documentada publicamente, mas é pública e sem autenticação.

---

## Problemas comuns

**Log mostra "Todas as tentativas falharam"**
→ A API da ALRS estava instável no momento. Tente rodar o workflow manualmente em 15-30 minutos.

**Rodou verde mas não veio email**
→ Se foi o primeiro run após um reset, verifique o spam. Se o log mostrar "Sem novidades", o estado já estava atualizado.

**Erro "Authentication failed" no log**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.

**Workflow não aparece em Actions**
→ Confirme que o arquivo está em `.github/workflows/monitor.yml`.

---

## Resetar o estado

Para forçar o reenvio de todas as proposições:

1. No repositório, clique em `estado.json` → lápis
2. Substitua o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode o workflow manualmente

---

## Horários de execução

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00       | 0 11 * * * |
| 12:00       | 0 15 * * * |
| 17:00       | 0 20 * * * |
| 21:00       | 0 0 * * *  |
