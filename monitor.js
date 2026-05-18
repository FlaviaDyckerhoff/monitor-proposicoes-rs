const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_URL = 'https://ww4.al.rs.gov.br:5000/listaProposicaoCompleto';

// A API da ALRS fica instável às vezes. Tentamos com folga para evitar falso negativo.
const MAX_TENTATIVAS = 5;
const ESPERA_ENTRE_TENTATIVAS_MS = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo
  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${p.tipo || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}/${p.ano || '-'}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ ALRS — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://ww4.al.rs.gov.br/legislativo">ww4.al.rs.gov.br/legislativo</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor ALRS" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ALRS: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

async function buscarProposicoes() {
  const ano = String(new Date().getFullYear());

  // Body idêntico ao que o frontend da ALRS envia.
  // siglaTipoProposicao vazio = todos os tipos.
  const body = {
    anoProposicao: ano,
    assunto1: "",
    assunto2: "",
    assunto3: "",
    codProponente: "",
    dataFim: "",
    dataIni: "",
    nomeProponente: "",
    nroProcesso: "",
    nroProposicao: "",
    page: 1,
    pageSize: 1000,
    proposicaoPaiId: "",
    siglaTipoProposicao: "",
    situacaoProposicao: "",
    tipoProponente: ""
  };

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    console.log(`🔍 Buscando proposições de ${ano}... (tentativa ${tentativa}/${MAX_TENTATIVAS})`);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://ww4.al.rs.gov.br/',
          'Origin': 'https://ww4.al.rs.gov.br'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000) // timeout de 60s
      });

      if (!response.ok) {
        console.error(`❌ Erro na API: ${response.status} ${response.statusText}`);
        const texto = await response.text();
        console.error('Resposta:', texto.substring(0, 300));
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      console.log('📦 Resposta da API (estrutura):', JSON.stringify(json).substring(0, 300));

      // Tenta extrair a lista de proposições de vários campos possíveis
      const lista = Array.isArray(json) ? json :
                    json.content ? json.content :
                    json.data ? json.data :
                    json.lista ? json.lista :
                    json.proposicoes ? json.proposicoes :
                    json.resultado ? json.resultado : [];

      console.log(`📊 ${lista.length} proposições recebidas`);
      return lista;

    } catch (err) {
      console.error(`⚠️ Tentativa ${tentativa} falhou: ${err.message}`);
      if (tentativa < MAX_TENTATIVAS) {
        console.log(`⏳ Aguardando ${ESPERA_ENTRE_TENTATIVAS_MS / 1000}s antes de tentar novamente...`);
        await sleep(ESPERA_ENTRE_TENTATIVAS_MS);
      }
    }
  }

  throw new Error('Todas as tentativas falharam. API da ALRS instavel.');
}

function gerarId(p) {
  // Tenta campo de ID direto, depois monta a partir de tipo+numero+ano
  return p.id || p.codigo || p.idProposicao || p.proposicaoId ||
    `${p.siglaTipoProposicao || p.sigla || p.tipo || ''}-${p.nroProposicao || p.numero || ''}-${p.anoProposicao || p.ano || ''}-${p.nomeProponente || ''}`.replace(/\s/g, '');
}

function normalizarProposicao(p) {
  // Campos observados no payload da ALRS: siglaTipoProposicao, nroProposicao,
  // anoProposicao, nomeProponente, dataApresentacao, ementa
  const tipo = p.siglaTipoProposicao || p.sigla || p.tipo || '-';
  const numero = p.nroProposicao || p.numero || p.nro || '-';
  const ano = p.anoProposicao || p.ano || '-';
  const autor = p.nomeProponente || p.autor || p.nomeAutor || p.autores || '-';
  const data = p.dataApresentacao || p.dthProtocolo || p.dataEntrada || p.data || '-';
  const ementa = (p.ementa || p.descricao || p.descricaoProposicao || '-').substring(0, 200);

  return {
    id: gerarId(p),
    tipo,
    numero,
    ano,
    autor,
    data,
    ementa,
  };
}

(async () => {
  console.log('🚀 Iniciando monitor ALRS...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    throw new Error('Nenhuma proposicao encontrada. API pode estar fora do ar.');
  }

  const proposicoes = proposicoesRaw.map(normalizarProposicao).filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    // Ordena por tipo alfabético, depois por número decrescente dentro de cada tipo
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
