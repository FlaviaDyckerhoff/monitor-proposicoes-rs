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
const DETAIL_BASE_URL = 'https://ww4.al.rs.gov.br/proposicao';
const STATUS_SEM_EMENTA = new Set(['autuado(a)', 'entrada', 'aprovado(a)']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(str) {
  return (str || '').toString()
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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

function montarUrlProposicao(p) {
  const tipo = encodeURIComponent(p.tipo || p.siglaTipoProposicao || p.sigla || '');
  const numero = encodeURIComponent(p.numero || p.nroProposicao || p.nro || '');
  const ano = encodeURIComponent(p.ano || p.anoProposicao || '');
  if (!tipo || !numero || !ano) return 'https://ww4.al.rs.gov.br/proposicao';
  return DETAIL_BASE_URL + '/' + tipo + '/' + numero + '/' + ano;
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
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${escapeHtml(p.tipo || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><a href="${p.url}" style="color:#003366;text-decoration:none"><strong>${escapeHtml(p.numero || '-')}/${escapeHtml(p.ano || '-')}</strong></a></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(p.autor || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${escapeHtml(p.data || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(p.ementa || '-')}</td>
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

function montarLinkProposicao(tipo, numero, ano) {
  if (!tipo || !numero || !ano || tipo === '-' || numero === '-' || ano === '-') {
    return 'https://ww4.al.rs.gov.br/legislativo';
  }
  return `https://ww4.al.rs.gov.br/proposicao/${encodeURIComponent(tipo)}/${encodeURIComponent(numero)}/${encodeURIComponent(ano)}`;
}

function limparTextoHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&aacute;/g, 'á')
    .replace(/&agrave;/g, 'à')
    .replace(/&acirc;/g, 'â')
    .replace(/&atilde;/g, 'ã')
    .replace(/&eacute;/g, 'é')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&ocirc;/g, 'ô')
    .replace(/&otilde;/g, 'õ')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ccedil;/g, 'ç')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairEmentaDaPagina(html) {
  const match = html.match(/<div[^>]+id=["']content-ementa["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!match) return '';
  return limparTextoHtml(match[1]).replace(/^Ementa\s*/i, '').trim();
}

async function buscarEmentaDetalhe(tipo, numero, ano) {
  const link = montarLinkProposicao(tipo, numero, ano);

  try {
    const response = await fetch(link, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    return extrairEmentaDaPagina(html);
  } catch (err) {
    console.warn(`⚠️ Não foi possível buscar ementa em ${link}: ${err.message}`);
    return '';
  }
}

async function normalizarProposicao(p) {
  // Campos observados no payload da ALRS: siglaTipoProposicao, nroProposicao,
  // anoProposicao, nomeProponente, dataApresentacao.
  // O campo descricao é situação/tramitação ("Autuado(a)", "Entrada" etc.),
  // não ementa. A ementa correta vem da página pública de detalhe.
  const tipo = p.siglaTipoProposicao || p.sigla || p.tipo || '-';
  const numero = p.nroProposicao || p.numero || p.nro || '-';
  const ano = p.anoProposicao || p.ano || '-';
  const autor = p.nomeProponente || p.autor || p.nomeAutor || p.autores || '-';
  const data = p.dataApresentacao || p.dthProtocolo || p.dataEntrada || p.data || '-';
  const url = montarUrlProposicao({ tipo, numero, ano });
  const ementaApi = (p.ementa || p.descricaoProposicao || p.descricao || '').trim();
  const ementa = STATUS_SEM_EMENTA.has(ementaApi.toLowerCase()) ? '-' : (ementaApi || '-').substring(0, 500);

  return {
    id: gerarId(p),
    tipo,
    numero,
    ano,
    autor,
    data,
    ementa,
    situacao: p.descricao || p.situacao || p.situacaoProposicao || '-',
    url,
  };
}

function extrairEmentaDetalhe(html) {
  const match = html.match(/<div[^>]+id=["']content-ementa["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return null;
  return stripHtml(match[1]);
}

async function enriquecerEmentaDetalhe(p) {
  if (!p.url || p.url === 'https://ww4.al.rs.gov.br/proposicao') return p;

  try {
    const response = await fetch(p.url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://ww4.al.rs.gov.br/proposicao',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ementa = extrairEmentaDetalhe(await response.text());
    if (ementa) p.ementa = ementa.substring(0, 500);
  } catch (err) {
    console.warn(`⚠️ Não consegui enriquecer ementa de ${p.tipo} ${p.numero}/${p.ano}: ${err.message}`);
  }

  return p;
}

async function enriquecerEmentasDetalhe(proposicoes) {
  for (const p of proposicoes) {
    await enriquecerEmentaDetalhe(p);
    await sleep(250);
  }
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

  const proposicoes = (await Promise.all(proposicoesRaw.map(normalizarProposicao))).filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enriquecerEmentasDetalhe(novas);

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
