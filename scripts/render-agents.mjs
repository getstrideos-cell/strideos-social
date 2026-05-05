import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createQueueItem, queuePath, readQueue, updateQueue } from "./queue-store.mjs";
import { refreshXAccessToken, XApiError } from "./x-client.mjs";
import { readXTokenState, writeXTokenState } from "./x-token-store.mjs";
import { createStructuredJson, hasOpenAI } from "./openai-client.mjs";
import { getGoogleAnalyticsStatus, runGoogleAnalyticsReport } from "./google-analytics-client.mjs";

const statePath = resolve(process.env.AGENT_STATE_PATH || join(dirname(queuePath), "agent-state.json"));
const timeZone = process.env.AGENT_TIMEZONE || "America/Sao_Paulo";
const boardHour = Number(process.env.FOUNDER_BOARD_HOUR || 8);
const boardMinute = Number(process.env.FOUNDER_BOARD_MINUTE || 30);
const growthHour = Number(process.env.GROWTH_PACK_HOUR || 9);
const growthMinute = Number(process.env.GROWTH_PACK_MINUTE || 0);
const momentHour = Number(process.env.FOUNDER_MOMENT_HOUR || 10);
const momentMinute = Number(process.env.FOUNDER_MOMENT_MINUTE || 30);
const schedulerIntervalMs = Number(process.env.AGENT_SCHEDULER_INTERVAL_MS || 60_000);
const targetHandles = (process.env.TARGET_X_HANDLES || "gregisenberg,noahkagan,george__mack,buildinpublic,openai,perplexity_ai,AnthropicAI")
  .split(",")
  .map((handle) => handle.trim().replace(/^@/, ""))
  .filter(Boolean);
const redditSubreddits = (process.env.REDDIT_SUBREDDITS || "SaaS,startups,Entrepreneur,SideProject,indiehackers")
  .split(",")
  .map((subreddit) => subreddit.trim().replace(/^r\//, ""))
  .filter(Boolean);
const redditQueries = (process.env.REDDIT_SEARCH_QUERIES || "solo founder,build in public,SaaS metrics,AI agents startup,distribution")
  .split(",")
  .map((query) => query.trim())
  .filter(Boolean);
const plausibleApiKey = process.env.PLAUSIBLE_API_KEY || "";
const plausibleSiteId = process.env.PLAUSIBLE_SITE_ID || "";
const plausibleHost = process.env.PLAUSIBLE_HOST || "https://plausible.io";
const posthogApiKey = process.env.POSTHOG_PERSONAL_API_KEY || "";
const posthogProjectId = process.env.POSTHOG_PROJECT_ID || "";
const posthogHost = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "");

let schedulerStarted = false;
let schedulerRunning = false;

export function startRenderAgents() {
  if (schedulerStarted || process.env.RENDER_AGENTS_ENABLED === "false") return;
  schedulerStarted = true;

  setInterval(async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await runDueRenderAgents();
    } catch (error) {
      console.error("Render agents failed:", error);
    } finally {
      schedulerRunning = false;
    }
  }, schedulerIntervalMs);

  console.log("Stride OS Render agents enabled.");
}

export async function runDueRenderAgents(now = new Date()) {
  const local = getLocalTimeParts(now);
  const results = [];

  if (isWithinScheduleWindow(local, boardHour, boardMinute)) {
    results.push(await generateFounderBoard({ reason: "schedule", now }));
  }

  if (isWithinScheduleWindow(local, growthHour, growthMinute)) {
    results.push(await generateDailyGrowthPack({ reason: "schedule", now }));
  }

  if (isWithinScheduleWindow(local, momentHour, momentMinute)) {
    results.push(await generateFounderMoment({ reason: "schedule", now }));
  }

  return results;
}

export async function generateDailyGrowthPack({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.growthPack?.date === today) {
    return { agent: "growth-pack", status: "skipped", date: today, reason: "already-created" };
  }

  const board = await ensureFounderBoard(today, now);
  const signals = board?.signals || (await collectTrendSignals());
  const rawItems = buildGrowthPackItems(today, signals, board);
  const enhancedItems = await enhanceGrowthPackWithOpenAI(rawItems, board, signals);
  const items = enhancedItems.map((item) =>
    createQueueItem({
      ...item,
      status: "draft",
      source: "render-growth-pack"
    })
  );

  await updateQueue((queue) => {
    queue.items.unshift(...items);
  });

  const latestState = await readAgentState();
  latestState.growthPack = {
    date: today,
    reason,
    createdAt: now.toISOString(),
    count: items.length,
    boardDate: board?.date || "",
    signals
  };
  await writeAgentState(latestState);

  return { agent: "growth-pack", status: "created", date: today, count: items.length };
}

export async function generateFounderBoard({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.founderBoard?.date === today) {
    return { agent: "founder-board", status: "skipped", date: today, reason: "already-created" };
  }

  const signals = await collectTrendSignals();
  const board = await enhanceFounderBoardWithOpenAI(buildFounderBoard(today, signals, now, reason));
  const latestState = await readAgentState();
  latestState.founderBoard = board;
  await writeAgentState(latestState);

  return { agent: "founder-board", status: "created", date: today, signals: signals.length };
}

export async function generateFounderMoment({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.founderMoment?.date === today) {
    return { agent: "founder-moment", status: "skipped", date: today, reason: "already-created" };
  }

  const signal = pickFounderMomentSignal(today);
  const item = createQueueItem({
    type: "post",
    format: "founder-moment",
    status: "draft",
    source: "render-founder-moment",
    requiresManualAsset: true,
    title: signal.title,
    recommendedSurface: signal.recommendedSurface,
    viralThesis: signal.viralThesis,
    evidence: signal.evidence,
    sourceUrl: signal.sourceUrl,
    trendSignal: signal.trendSignal,
    whyNow: signal.whyNow,
    visualBrief: signal.visualBrief,
    captureInstruction: signal.captureInstruction,
    postingNotes: signal.postingNotes,
    imageAlt: signal.imageAlt,
    text: signal.text
  });

  await updateQueue((queue) => {
    queue.items.unshift(item);
  });

  const latestState = await readAgentState();
  latestState.founderMoment = {
    date: today,
    reason,
    createdAt: now.toISOString(),
    title: item.title
  };
  await writeAgentState(latestState);

  return { agent: "founder-moment", status: "created", date: today, count: 1 };
}

export async function readAgentState() {
  try {
    const content = await readFile(statePath, "utf8");
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      console.warn("Agent state file is not valid JSON yet; using empty state for this run.");
      return {};
    }
    throw error;
  }
}

async function ensureFounderBoard(today, now) {
  const state = await readAgentState();
  if (state.founderBoard?.date === today) return state.founderBoard;

  const result = await generateFounderBoard({ reason: "growth-pack-dependency", now });
  if (result.status === "skipped") {
    return (await readAgentState()).founderBoard;
  }

  return (await readAgentState()).founderBoard;
}

function buildFounderBoard(today, signals, now, reason) {
  const primarySignal = signals[0] || { label: "fundadores solo estão usando IA para enviar e distribuir mais rápido", source: "fallback" };
  const communitySignal =
    signals.find((signal) => signal.kind === "community") ||
    signals.find((signal) => signal.label?.toLowerCase().includes("build")) ||
    primarySignal;
  const aiSignal =
    signals.find((signal) => /ai|agent|claude|openai|anthropic/i.test(signal.label || "")) ||
    primarySignal;

  return {
    date: today,
    reason,
    createdAt: now.toISOString(),
    stage: "Landing page no ar. Produto principal do Stride OS ainda em desenvolvimento. O agente social e o fluxo de aprovação são a primeira cunha funcional.",
    signals,
    integrations: buildIntegrationStatus(signals),
    intelligence: hasOpenAI() ? "Aprimorado por OpenAI" : "Modo fallback",
    marketRadar: {
      title: "Radar de Mercado",
      summary: "Fundadores solo estão prestando atenção em alavancagem com IA, distribuição e trabalho real. A oportunidade é posicionar o Stride OS como o ritmo operacional que transforma progresso real em narrativa pública.",
      topSignals: signals.slice(0, 4).map((signal) => ({
        label: signal.label,
        source: signal.source,
        url: signal.url || signal.targetPostUrl || "",
        evidence: evidenceFor(signal)
      })),
      implication: "Não posicione o Stride OS como brinquedo de automação polido. Posicione como camada operacional do fundador que começa enquanto o produto ainda está sendo construído."
    },
    marketingDirector: {
      title: "Diretor de Marketing",
      distributionBet: "Use o X como canal de prova e depois reaproveite as melhores ideias na comunidade build-in-public e em posts no Reddit voltados a fundadores.",
      reasoning: `O ângulo mais forte agora é: ${primarySignal.label}. O Stride OS pode entrar nessa conversa mostrando como um fundador solo transforma progresso em distribuição sem soar como uma máquina de conteúdo.`,
      recommendedActions: [
        "Publicar um post no perfil nomeando o estágio atual com honestidade: landing page no ar, produto em desenvolvimento, sistema de distribuição sendo construído em público.",
        "Deixar uma resposta relevante em um post de conta grande sobre agentes de IA, fundadores solo, distribuição ou envio de produto.",
        "Postar uma pergunta não-promocional na comunidade build-in-public para entender como fundadores criam updates semanais hoje."
      ],
      experiment: {
        name: "Prova antes do produto",
        hypothesis: "Trabalho real e honesto em estágio inicial vai gerar respostas melhores do que afirmações polidas sobre o produto.",
        metric: "Respostas de fundadores solo, visitas ao perfil e cliques na landing page.",
        duration: "7 dias"
      },
      risk: "Se todos os posts apontarem direto pro Stride OS, vai parecer promoção. Mantenha a maioria dos posts enquadrada como lição operacional de fundador."
    },
    productDirector: {
      title: "Diretor de Produto",
      productBet: "Construir o ritual semanal de update do fundador antes de adicionar analytics amplos ou muitos canais.",
      reasoning: "O valor central do produto não é escrever tweets. É ajudar um fundador solo a saber o que mudou, explicar com clareza e construir um hábito de distribuição baseado em dados reais do negócio.",
      roadmapNow: [
        "Fluxo de check-in semanal: snapshot do Stripe mais cinco perguntas do fundador.",
        "Fila de aprovação com evidência, superfície e racional para cada draft.",
        "Loop de aprendizado: depois de publicar, capturar o que gerou respostas/cliques e realimentar nas recomendações da próxima semana."
      ],
      roadmapLater: [
        "Fluxos de postagem específicos para Reddit e comunidades.",
        "Recomendações de conversão da landing page a partir de comentários e objeções.",
        "Caixa de feedback do produto que transforma respostas em sugestões de roadmap."
      ],
      risk: "Não construir demais a metáfora do agente executivo antes do loop de update semanal parecer obviamente útil."
    },
    chiefOfStaff: {
      title: "Chief of Staff",
      todayFocus: "Use o conselho para produzir um post público de prova de trabalho, um post de aprendizado em comunidade e uma resposta com alto contexto.",
      decisions: [
        "Manter o Stride OS honesto sobre o estágio: landing page e projeto ativo, não lançamento completo do app.",
        "Priorizar aprendizado de distribuição sobre amplitude de features nesta semana.",
        "Tratar respostas e posts em comunidade como pesquisa de mercado, não só engajamento."
      ],
      nextMove: "Gerar o pacote de crescimento, aprovar apenas drafts com evidência e rejeitar qualquer coisa que pareça conselho genérico de build-in-public."
    },
    growthExperiment: {
      title: "Experimento de Crescimento",
      name: "Narrativa do Conselho do Founder",
      channel: "Perfil no X mais comunidade build-in-public",
      hypothesis: "Um fundador solo construindo publicamente com um conselho de IA é mais memorável do que mais uma ferramenta de agendamento de SaaS.",
      action: "Postar uma nota transparente sobre adicionar agentes Diretor de Marketing e Diretor de Produto ao Stride OS.",
      evidence: evidenceFor(aiSignal),
      sourceUrl: aiSignal.url || aiSignal.targetPostUrl || "",
      successMetric: "Pelo menos uma resposta qualificada de fundador, DM ou clique na landing."
    }
  };
}

async function enhanceFounderBoardWithOpenAI(board) {
  if (!hasOpenAI()) return board;

  try {
    const enhanced = await createStructuredJson({
      name: "founder_board",
      schema: founderBoardSchema,
      maxOutputTokens: 7000,
      instructions: [
        "Você é o Conselho do Founder por IA do Stride OS.",
        "Aja como um CMO pragmático, CPO, líder de Inteligência de Mercado, Chief of Staff e líder de Growth para um fundador solo.",
        "Stride OS hoje: landing page no ar, produto principal ainda em desenvolvimento, fluxo de aprovação social existe, produto no Stripe ainda não está pronto.",
        "Audiência: fundadores solo construindo SaaS em estágio inicial em público.",
        "Voz: builder prático com leve toque visionário. Honesto, direto, sem hype genérico de IA.",
        "Use apenas os signals fornecidos. Não invente métricas, clientes, receita, lançamentos ou features de produto.",
        "Escreva todo o conteúdo em PORTUGUÊS BRASILEIRO. O texto que vai para os posts é tratado em outra etapa, aqui é apenas conteúdo estratégico para o fundador ler.",
        "Retorne orientação estratégica concisa que possa alimentar diretamente conteúdo, respostas, posts em comunidade e decisões de roadmap."
      ].join("\n"),
      input: JSON.stringify({
        stage: board.stage,
        integrations: board.integrations,
        signals: compactSignals(board.signals).slice(0, 8),
        fallbackBoard: {
          marketRadar: board.marketRadar,
          marketingDirector: board.marketingDirector,
          productDirector: board.productDirector,
          chiefOfStaff: board.chiefOfStaff,
          growthExperiment: board.growthExperiment
        }
      })
    });

    return {
      ...board,
      intelligence: "Aprimorado por OpenAI",
      marketRadar: { title: "Radar de Mercado", ...enhanced.marketRadar },
      marketingDirector: { title: "Diretor de Marketing", ...enhanced.marketingDirector },
      productDirector: { title: "Diretor de Produto", ...enhanced.productDirector },
      chiefOfStaff: { title: "Chief of Staff", ...enhanced.chiefOfStaff },
      growthExperiment: { title: "Experimento de Crescimento", ...enhanced.growthExperiment }
    };
  } catch (error) {
    console.warn("OpenAI founder board enhancement failed:", error.message);
    return {
      ...board,
      intelligence: "Modo fallback",
      openAIError: "A OpenAI não conseguiu concluir a análise agora. O conselho usou o modo fallback e vai tentar de novo na próxima execução."
    };
  }
}

async function enhanceGrowthPackWithOpenAI(items, board, signals) {
  if (!hasOpenAI()) return items;

  try {
    const enhanced = await createStructuredJson({
      name: "growth_pack",
      schema: growthPackSchema,
      maxOutputTokens: 5000,
      instructions: [
        "Você é o estrategista de conteúdo do Stride OS.",
        "Reescreva ou melhore os itens de draft fornecidos usando o contexto do Conselho do Founder.",
        "IMPORTANTE: o campo `text` (texto público que vai pro X) DEVE permanecer em INGLÊS — é o post final que vai pro Twitter/X.",
        "Todos os outros campos auxiliares (recommendedSurface, viralThesis, evidence, trendSignal) devem ser escritos em PORTUGUÊS BRASILEIRO — eles são lidos pelo fundador no painel, não publicados.",
        "Mantenha cada texto público (`text`) abaixo de 280 caracteres.",
        "A saída deve conter exatamente cinco itens.",
        "Inclua pelo menos um item community-post.",
        "Mantenha itens reply apenas se eles tiverem um replyToPostId real vindo do input.",
        "Não finja que o Stride OS está totalmente lançado. Atualmente tem só uma landing page e o projeto em desenvolvimento.",
        "Sem hashtags a não ser que sejam genuinamente necessárias. Sem hype com cara de IA. Sem métricas falsas."
      ].join("\n"),
      input: JSON.stringify({
        board: {
          stage: board?.stage,
          marketRadar: board?.marketRadar,
          marketingDirector: board?.marketingDirector,
          productDirector: board?.productDirector,
          chiefOfStaff: board?.chiefOfStaff,
          growthExperiment: board?.growthExperiment
        },
        signals: compactSignals(signals).slice(0, 8),
        draftItems: items
      })
    });

    const byReplyId = new Map(items.filter((item) => item.replyToPostId).map((item) => [item.replyToPostId, item]));
    return enhanced.items.slice(0, 5).map((item, index) => {
      const original = item.replyToPostId ? byReplyId.get(item.replyToPostId) || items[index] || {} : items[index] || {};
      const format = item.format === "community-post" ? "community-post" : original.format;
      return {
        ...original,
        type: item.type === "reply" && item.replyToPostId ? "reply" : "post",
        format,
        requiresManualPublish: format === "community-post" || Boolean(original.requiresManualPublish),
        recommendedSurface: item.recommendedSurface,
        viralThesis: item.viralThesis,
        evidence: item.evidence,
        sourceUrl: item.sourceUrl || original.sourceUrl,
        trendSignal: item.trendSignal,
        text: trimPost(item.text)
      };
    });
  } catch (error) {
    console.warn("OpenAI growth pack enhancement failed:", error.message);
    return items;
  }
}

function compactSignals(signals = []) {
  return signals.map((signal) => ({
    kind: signal.kind || "",
    source: signal.source || "",
    label: signal.label || "",
    url: signal.url || signal.targetPostUrl || "",
    evidence: evidenceFor(signal),
    metrics: signal.metrics || {}
  }));
}

function buildIntegrationStatus(signals) {
  const sources = new Set(signals.map((signal) => signal.source).filter(Boolean));
  return [
    {
      name: "Radar de mercado no X",
      status: sources.has("x") ? "Conectado" : "Sinal insuficiente",
      detail: "Lê posts recentes de contas-alvo quando o acesso de leitura da API do X está disponível."
    },
    {
      name: "Performance no X",
      status: sources.has("x-performance") ? "Conectado" : "Aguardando",
      detail: "Aprende com seus posts publicados assim que eles têm métricas no X."
    },
    {
      name: "Analytics da landing",
      status: sources.has("plausible") || sources.has("posthog") || sources.has("google-analytics") ? "Conectado" : "Precisa conectar",
      detail: "Usa Google Analytics OAuth, Plausible ou PostHog quando conectados."
    },
    {
      name: "Radar de Reddit/comunidades",
      status: sources.has("reddit") ? "Conectado" : "Limitado",
      detail: `Monitora r/${redditSubreddits.slice(0, 3).join(", r/")} e buscas relacionadas a fundadores.`
    },
    {
      name: "Feedback interno",
      status: sources.has("strideos") ? "Conectado" : "Aguardando",
      detail: "Usa aprovações, rejeições, falhas, sugestões manuais e histórico da fila de publicados."
    }
  ];
}

function buildGrowthPackItems(today, signals) {
  const xSignals = signals.filter((signal) => signal.kind === "x-post");
  const primarySignal = signals[0] || { label: "agentes de IA estão deixando fundadores solo mais rápidos", source: "fallback" };
  const communitySignal =
    signals.find((signal) => signal.kind === "community") ||
    signals[1] ||
    { label: "build-in-public funciona melhor quando os updates estão ancorados em progresso real", source: "fallback" };
  const replyTargets = xSignals.filter((signal) => signal.replyToPostId && signal.replySettings === "everyone").slice(0, 2);

  const items = [
    {
      type: "post",
      recommendedSurface: "Perfil Stride OS",
      viralThesis: "Contrário e específico de fundador: contraria a narrativa genérica de velocidade da IA e nomeia o novo gargalo.",
      evidence: evidenceFor(primarySignal),
      sourceUrl: primarySignal.url,
      trendSignal: primarySignal.label,
      text: trimPost(`AI makes the first build easier.\n\nThat is not the same as making the founder easier to trust.\n\nThe new bottleneck for solo founders is clarity:\nwhat changed, what moved, what broke, and why anyone should keep watching.`)
    },
    {
      type: "post",
      recommendedSurface: "Perfil Stride OS",
      viralThesis: "Transparência sobre o estágio passa mais credibilidade do que afirmações polidas sobre o produto e atrai builders que querem o processo real.",
      evidence: "O Stride OS hoje é landing page mais projeto ativo, então o post se ancora no build real em vez de fingir que o produto completo já está pronto.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Fundadores respondem a processo honesto quando o produto ainda está sendo construído.",
      text: trimPost(`Current Stride OS status:\n\nlanding page live\nproduct still being built\nsocial agent working before the core app is polished\n\nIt feels backwards, but maybe that is the point.\n\nDistribution is part of the product now.`)
    },
    {
      type: "post",
      recommendedSurface: "Perfil Stride OS",
      viralThesis: "O ângulo de conselho executivo de IA é mais ownable que conselho genérico de build-in-public e faz o Stride OS parecer maior que um gerador de posts.",
      evidence: "O Stride OS agora tem Radar de Mercado alimentando recomendações de Diretor de Marketing e Diretor de Produto antes dos drafts de conteúdo serem criados.",
      trendSignal: "Fundadores solo estão buscando alavancagem que pareça um time operando, não só prompts de IA isolados.",
      text: trimPost(`I am adding a tiny founder board to Stride OS:\n\nMarket Radar -> Marketing Director -> Product Director -> content agents\n\nThe goal is not more posts.\n\nThe goal is better founder decisions that turn into better public updates.`)
    },
    {
      type: "post",
      format: "community-post",
      requiresManualPublish: true,
      recommendedSurface: "Comunidade build-in-public no X",
      viralThesis: "Formato de pergunta convida outros builders a comparar workflows; otimizado para respostas e relacionamento, não para pitch direto.",
      evidence: evidenceFor(communitySignal),
      sourceUrl: "https://x.com/i/communities/1493446837214187523",
      trendSignal: communitySignal.label,
      text: trimPost(`Question for builders here:\n\nwhen you post a weekly update, where does it start?\n\n1. memory\n2. changelog\n3. metrics\n4. screenshots\n5. whatever feels important that day\n\nI am trying to understand the real workflow behind consistent build in public.`)
    }
  ];

  for (const target of replyTargets) {
    items.push({
      type: "reply",
      replyToPostId: target.replyToPostId,
      targetAuthor: target.targetAuthor,
      targetHandle: target.targetHandle,
      targetPostUrl: target.targetPostUrl,
      targetPostText: target.targetPostText,
      targetPostSummary: target.targetPostSummary,
      replyRationale: `Post relevante de ${target.targetHandle} com respostas públicas abertas; a resposta adiciona a visão do Stride OS sem fazer pitch.`,
      recommendedSurface: `Resposta a ${target.targetHandle}`,
      viralThesis: "Responder a um post de conta grande com bom sinal pode gerar descoberta; a resposta é enquadrada como insight de fundador, não como anúncio de produto.",
      evidence: evidenceFor(target),
      sourceUrl: target.targetPostUrl,
      trendSignal: target.label,
      text: trimPost(replyTextFor(target))
    });
  }

  while (items.length < 5) {
    items.push(nextProfilePost(items.length, communitySignal));
  }

  return items.slice(0, 5).map((item) => ({ ...item, generatedForDate: today }));
}

async function collectTrendSignals() {
  const fallback = [
    { label: "AI agents are making solo founders faster", source: "fallback", kind: "trend" },
    { label: "real progress beats polished founder theater", source: "fallback", kind: "community" }
  ];

  const queries = ["AI agents solo founder SaaS", "build in public SaaS founder metrics"];
  const signals = [];

  signals.push(...(await collectXSignals()));
  signals.push(...(await collectXPerformanceSignals()));
  signals.push(...(await collectPlausibleSignals()));
  signals.push(...(await collectPostHogSignals()));
  signals.push(...(await collectGoogleAnalyticsSignals()));
  signals.push(...(await collectRedditSignals()));
  signals.push(...(await collectInternalFeedbackSignals()));

  for (const query of queries) {
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const json = await response.json();
      const hit = json.hits?.find((candidate) => candidate.title || candidate.story_title);
      const title = hit?.title || hit?.story_title;
      if (title) signals.push({ label: title, source: "hn", kind: "trend", url: hit.url || hit.story_url || "" });
    } catch {
      // Fallback signals keep the agent reliable when source fetches fail.
    }
  }

  return dedupeSignals(signals).length > 0 ? dedupeSignals(signals).slice(0, 12) : fallback;
}

async function collectXSignals() {
  const tokenState = await getFreshXTokenState();
  if (!tokenState.accessToken) return [];

  const signals = [];

  for (const handle of targetHandles) {
    try {
      const user = await xFetchJson(
        `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,verified`,
        tokenState
      );
      const userId = user?.data?.id;
      if (!userId) continue;

      const tweets = await xFetchJson(
        `https://api.x.com/2/users/${userId}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,public_metrics,reply_settings,conversation_id`,
        tokenState
      );

      for (const tweet of tweets?.data || []) {
        const metrics = tweet.public_metrics || {};
        const text = normalizeTweetText(tweet.text || "");
        const relevant = isRelevantTweet(text);
        if (!relevant) continue;

        const handleWithAt = `@${handle}`;
        const score =
          Number(metrics.like_count || 0) +
          Number(metrics.reply_count || 0) * 4 +
          Number(metrics.retweet_count || 0) * 3 +
          Number(metrics.quote_count || 0) * 3;

        signals.push({
          kind: handle === "buildinpublic" ? "community" : "x-post",
          label: `${handleWithAt}: ${text.slice(0, 120)}`,
          source: "x",
          url: `https://x.com/${handle}/status/${tweet.id}`,
          targetPostUrl: `https://x.com/${handle}/status/${tweet.id}`,
          replyToPostId: tweet.id,
          targetAuthor: user.data.name || handleWithAt,
          targetHandle: handleWithAt,
          targetPostText: text,
          targetPostSummary: summarizeTweet(text),
          replySettings: tweet.reply_settings || "unknown",
          metrics,
          score
        });
      }
    } catch (error) {
      console.warn(`Could not collect X signals for ${handle}:`, error.message);
    }
  }

  return signals.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 4);
}

async function collectXPerformanceSignals() {
  const tokenState = await getFreshXTokenState();
  if (!tokenState.accessToken) return [];

  let queue;
  try {
    queue = await readQueue();
  } catch {
    return [];
  }

  const ids = queue.items
    .filter((item) => item.status === "published" && item.xPostId)
    .slice(0, 25)
    .map((item) => item.xPostId);
  if (ids.length === 0) return [];

  try {
    const tweets = await xFetchJson(
      `https://api.x.com/2/tweets?ids=${encodeURIComponent(ids.join(","))}&tweet.fields=created_at,public_metrics,text`,
      tokenState
    );
    return (tweets.data || [])
      .map((tweet) => {
        const metrics = tweet.public_metrics || {};
        const score =
          Number(metrics.like_count || 0) +
          Number(metrics.reply_count || 0) * 4 +
          Number(metrics.retweet_count || 0) * 3 +
          Number(metrics.quote_count || 0) * 3;
        return {
          kind: "performance",
          source: "x-performance",
          label: `Performance do post publicado: ${normalizeTweetText(tweet.text || "").slice(0, 120)}`,
          url: `https://x.com/i/web/status/${tweet.id}`,
          metrics,
          score
        };
      })
      .filter((signal) => signal.score > 0)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 3);
  } catch (error) {
    console.warn("Could not collect X performance signals:", error.message);
    return [];
  }
}

async function collectPlausibleSignals() {
  if (!plausibleApiKey || !plausibleSiteId) return [];

  try {
    const overview = await plausibleQuery({
      site_id: plausibleSiteId,
      metrics: ["visitors", "pageviews", "visits", "bounce_rate"],
      date_range: "7d"
    });
    const sources = await plausibleQuery({
      site_id: plausibleSiteId,
      metrics: ["visitors"],
      dimensions: ["visit:source"],
      date_range: "7d",
      order_by: [["visitors", "desc"]],
      pagination: { limit: 5, offset: 0 }
    });

    const overviewRow = overview.results?.[0]?.metrics || [];
    const topSource = sources.results?.[0];
    const visitors = Number(overviewRow[0] || 0);
    const pageviews = Number(overviewRow[1] || 0);
    const topSourceName = topSource?.dimensions?.[0] || "";
    const topSourceVisitors = Number(topSource?.metrics?.[0] || 0);

    return [
      {
        kind: "landing-analytics",
        source: "plausible",
        label: `Analytics da landing: ${visitors} visitantes e ${pageviews} pageviews nos últimos 7 dias${topSourceName ? `; top fonte ${topSourceName} com ${topSourceVisitors} visitantes` : ""}`,
        metrics: { visitors, pageviews, topSourceVisitors },
        score: visitors + topSourceVisitors * 2
      }
    ];
  } catch (error) {
    console.warn("Could not collect Plausible signals:", error.message);
    return [];
  }
}

async function plausibleQuery(body) {
  const response = await fetch(`${plausibleHost.replace(/\/$/, "")}/api/v2/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plausibleApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Plausible returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  return json;
}

async function collectPostHogSignals() {
  if (!posthogApiKey || !posthogProjectId) return [];

  try {
    const events = await posthogQuery(
      "SELECT event, count() AS event_count FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY event_count DESC LIMIT 5"
    );
    const urls = await posthogQuery(
      "SELECT properties.$current_url AS url, count() AS views FROM events WHERE timestamp > now() - INTERVAL 7 DAY AND event = '$pageview' GROUP BY url ORDER BY views DESC LIMIT 5"
    );

    const topEvent = events.results?.[0] || [];
    const topUrl = urls.results?.[0] || [];
    const topEventName = topEvent[0] || "";
    const topEventCount = Number(topEvent[1] || 0);
    const topUrlValue = topUrl[0] || "";
    const topUrlViews = Number(topUrl[1] || 0);

    return [
      {
        kind: "product-analytics",
        source: "posthog",
        label: `Analytics de produto/landing: top evento ${topEventName || "desconhecido"} (${topEventCount}); top página ${topUrlValue || "desconhecida"} (${topUrlViews} visualizações)`,
        url: topUrlValue,
        metrics: { topEventCount, topUrlViews },
        score: topEventCount + topUrlViews
      }
    ];
  } catch (error) {
    console.warn("Could not collect PostHog signals:", error.message);
    return [];
  }
}

async function collectGoogleAnalyticsSignals() {
  const status = await getGoogleAnalyticsStatus();
  if (!status.configured || !status.connected) return [];

  try {
    const overview = await runGoogleAnalyticsReport({
      metrics: ["activeUsers", "screenPageViews", "sessions", "engagementRate"],
      limit: 1
    });
    const sources = await runGoogleAnalyticsReport({
      dimensions: ["sessionSource"],
      metrics: ["activeUsers", "sessions"],
      limit: 5
    });
    const pages = await runGoogleAnalyticsReport({
      dimensions: ["pagePath"],
      metrics: ["screenPageViews", "activeUsers"],
      limit: 5
    });

    const metrics = overview.rows?.[0]?.metricValues || [];
    const activeUsers = Number(metrics[0]?.value || 0);
    const pageViews = Number(metrics[1]?.value || 0);
    const sessions = Number(metrics[2]?.value || 0);
    const engagementRate = Number(metrics[3]?.value || 0);
    const topSource = sources.rows?.[0];
    const topPage = pages.rows?.[0];
    const topSourceName = topSource?.dimensionValues?.[0]?.value || "";
    const topSourceUsers = Number(topSource?.metricValues?.[0]?.value || 0);
    const topPagePath = topPage?.dimensionValues?.[0]?.value || "";
    const topPageViews = Number(topPage?.metricValues?.[0]?.value || 0);

    return [
      {
        kind: "landing-analytics",
        source: "google-analytics",
        label: `Google Analytics: ${activeUsers} usuários ativos, ${sessions} sessões, ${pageViews} pageviews nos últimos 7 dias${topSourceName ? `; top fonte ${topSourceName} com ${topSourceUsers} usuários` : ""}${topPagePath ? `; top página ${topPagePath} com ${topPageViews} visualizações` : ""}`,
        metrics: { activeUsers, sessions, pageViews, engagementRate, topSourceUsers, topPageViews },
        score: activeUsers + sessions + topSourceUsers * 2 + topPageViews
      }
    ];
  } catch (error) {
    console.warn("Could not collect Google Analytics signals:", error.message);
    return [];
  }
}

async function posthogQuery(query) {
  const response = await fetch(`${posthogHost}/api/projects/${encodeURIComponent(posthogProjectId)}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${posthogApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PostHog returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  return json;
}

async function collectRedditSignals() {
  const signals = [];
  let loggedFailure = false;

  for (const subreddit of redditSubreddits.slice(0, 6)) {
    for (const query of redditQueries.slice(0, 3)) {
      try {
        const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=hot&t=week&limit=5&raw_json=1`;
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "StrideOSSocial/0.1 by getstrideos"
          }
        });
        if (!response.ok) continue;
        const json = await response.json();
        for (const child of json.data?.children || []) {
          const post = child.data || {};
          const text = normalizeTweetText(`${post.title || ""} ${post.selftext || ""}`);
          if (!isRelevantTweet(text)) continue;
          const score = Number(post.score || 0) + Number(post.num_comments || 0) * 3;
          signals.push({
            kind: "reddit",
            source: "reddit",
            label: `r/${subreddit}: ${post.title || text.slice(0, 120)}`,
            url: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
            metrics: { score: post.score || 0, comments: post.num_comments || 0 },
            score
          });
        }
      } catch (error) {
        if (!loggedFailure) {
          console.warn("Could not collect Reddit signals:", error.message);
          loggedFailure = true;
        }
      }
    }
  }

  return signals.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5);
}

async function collectInternalFeedbackSignals() {
  try {
    const queue = await readQueue();
    const rejected = queue.items.filter((item) => item.status === "rejected").length;
    const failed = queue.items.filter((item) => item.status === "failed").length;
    const published = queue.items.filter((item) => item.status === "published").length;
    const approved = queue.items.filter((item) => item.status === "approved").length;
    const manual = queue.items.filter((item) => item.requiresManualAsset || item.requiresManualPublish).length;

    return [
      {
        kind: "internal-feedback",
        source: "strideos",
        label: `Fila interna: ${published} publicados, ${approved} aprovados, ${rejected} rejeitados, ${failed} falharam, ${manual} sugestões manuais`,
        metrics: { published, approved, rejected, failed, manual },
        score: published + rejected + manual
      }
    ];
  } catch {
    return [];
  }
}

async function getFreshXTokenState() {
  const tokenState = await readXTokenState();
  if (!tokenState.accessToken) return tokenState;

  return tokenState;
}

async function xFetchJson(url, tokenState) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenState.accessToken}`,
      Accept: "application/json"
    }
  });
  const json = await response.json().catch(() => ({}));

  if (response.status === 401 && tokenState.refreshToken) {
    const refreshed = await refreshXAccessToken({
      refreshToken: tokenState.refreshToken,
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET
    });
    tokenState.accessToken = refreshed.accessToken;
    tokenState.refreshToken = refreshed.refreshToken;
    tokenState.refreshedAt = new Date().toISOString();
    await writeXTokenState(tokenState);
    return xFetchJson(url, tokenState);
  }

  if (!response.ok) {
    throw new XApiError(response.status, json, `X API returned ${response.status}`);
  }

  return json;
}

function evidenceFor(signal) {
  if (!signal) return "";
  if (signal.source === "x") {
    const metrics = signal.metrics || {};
    const metricText = [
      metrics.like_count ? `${metrics.like_count} curtidas` : "",
      metrics.reply_count ? `${metrics.reply_count} respostas` : "",
      metrics.retweet_count ? `${metrics.retweet_count} reposts` : ""
    ]
      .filter(Boolean)
      .join(", ");
    return `Post de ${signal.targetHandle || "X"} sobre um tema relevante de fundador/IA/build-in-public${metricText ? ` com ${metricText}` : ""}.`;
  }
  if (signal.source === "x-performance") {
    const metrics = signal.metrics || {};
    return `Seu post publicado teve ${metrics.like_count || 0} curtidas, ${metrics.reply_count || 0} respostas, ${metrics.retweet_count || 0} reposts e ${metrics.quote_count || 0} citações.`;
  }
  if (signal.source === "plausible") return signal.label;
  if (signal.source === "posthog") return signal.label;
  if (signal.source === "google-analytics") return signal.label;
  if (signal.source === "reddit") {
    const metrics = signal.metrics || {};
    return `Discussão no Reddit com ${metrics.score || 0} upvotes e ${metrics.comments || 0} comentários.`;
  }
  if (signal.source === "strideos") return signal.label;
  if (signal.source === "hn") return `Sinal recente do Hacker News: ${signal.label}.`;
  return `Encaixe estratégico com o Stride OS: ${signal.label}.`;
}

function dedupeSignals(signals) {
  const seen = new Set();
  const unique = [];
  for (const signal of signals) {
    const key = `${signal.source || ""}:${signal.url || signal.label || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

const stringArraySchema = {
  type: "array",
  items: { type: "string" }
};

const signalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    source: { type: "string" },
    url: { type: "string" },
    evidence: { type: "string" }
  },
  required: ["label", "source", "url", "evidence"]
};

const founderBoardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    marketRadar: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        implication: { type: "string" },
        topSignals: { type: "array", items: signalSchema }
      },
      required: ["summary", "implication", "topSignals"]
    },
    marketingDirector: {
      type: "object",
      additionalProperties: false,
      properties: {
        distributionBet: { type: "string" },
        reasoning: { type: "string" },
        recommendedActions: stringArraySchema,
        experiment: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            hypothesis: { type: "string" },
            metric: { type: "string" },
            duration: { type: "string" }
          },
          required: ["name", "hypothesis", "metric", "duration"]
        },
        risk: { type: "string" }
      },
      required: ["distributionBet", "reasoning", "recommendedActions", "experiment", "risk"]
    },
    productDirector: {
      type: "object",
      additionalProperties: false,
      properties: {
        productBet: { type: "string" },
        reasoning: { type: "string" },
        roadmapNow: stringArraySchema,
        roadmapLater: stringArraySchema,
        risk: { type: "string" }
      },
      required: ["productBet", "reasoning", "roadmapNow", "roadmapLater", "risk"]
    },
    chiefOfStaff: {
      type: "object",
      additionalProperties: false,
      properties: {
        todayFocus: { type: "string" },
        decisions: stringArraySchema,
        nextMove: { type: "string" }
      },
      required: ["todayFocus", "decisions", "nextMove"]
    },
    growthExperiment: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        channel: { type: "string" },
        hypothesis: { type: "string" },
        action: { type: "string" },
        evidence: { type: "string" },
        sourceUrl: { type: "string" },
        successMetric: { type: "string" }
      },
      required: ["name", "channel", "hypothesis", "action", "evidence", "sourceUrl", "successMetric"]
    }
  },
  required: ["marketRadar", "marketingDirector", "productDirector", "chiefOfStaff", "growthExperiment"]
};

const growthPackItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["post", "reply"] },
    format: { type: "string", enum: ["standard", "community-post"] },
    replyToPostId: { type: "string" },
    recommendedSurface: { type: "string" },
    viralThesis: { type: "string" },
    evidence: { type: "string" },
    sourceUrl: { type: "string" },
    trendSignal: { type: "string" },
    text: { type: "string" }
  },
  required: ["type", "format", "replyToPostId", "recommendedSurface", "viralThesis", "evidence", "sourceUrl", "trendSignal", "text"]
};

const growthPackSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: growthPackItemSchema
    }
  },
  required: ["items"]
};

function replyTextFor(signal) {
  const text = (signal.targetPostText || "").toLowerCase();
  if (text.includes("agent") || text.includes("ai")) {
    return "The underrated shift is that AI makes shipping faster, but clarity becomes more valuable.\n\nSolo founders still need a rhythm for what changed, what moved, and what is worth sharing.";
  }
  if (text.includes("distribution") || text.includes("audience")) {
    return "This is the part founders underestimate.\n\nDistribution gets easier when the weekly story is tied to real progress, not just opinions or polished launch posts.";
  }
  return "The best build-in-public updates usually do not feel like content.\n\nThey feel like a clear operating note: what changed, what was learned, and what happens next.";
}

function normalizeTweetText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isRelevantTweet(text) {
  const lower = text.toLowerCase();
  return [
    "solo founder",
    "founder",
    "build in public",
    "building in public",
    "saas",
    "startup",
    "distribution",
    "ai agent",
    "agents",
    "ship",
    "shipping",
    "audience",
    "revenue",
    "mrr"
  ].some((keyword) => lower.includes(keyword));
}

function summarizeTweet(text) {
  if (text.length <= 180) return text;
  return `${text.slice(0, 177).trimEnd()}...`;
}

function pickFounderMomentSignal(today) {
  const options = [
    {
      title: "Landing page antes do produto",
      recommendedSurface: "Post manual no perfil Stride OS",
      viralThesis: "Uma foto real do laptop/workspace torna o build em estágio inicial tangível e evita o padrão genérico de conselho de fundador gerado por IA.",
      evidence: "O produto ainda está em desenvolvimento enquanto a landing page e o agente social já existem. Essa tensão é a história.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Fundadores estão usando IA pra entregar mais rápido, mas distribuição e narrativa agora começam antes do produto completo estar pronto.",
      whyNow: "O Stride OS hoje é honestamente landing page mais projeto ativo. Mostrar esse estágio faz o build parecer real e evita exagero.",
      visualBrief: "Tire uma foto do seu laptop com a landing page do Stride OS aberta e seu projeto/editor ou anotações visíveis ao lado. Não mostre telas de produto falsas.",
      captureInstruction: "Abra getstrideos.com de um lado e seu workspace ou anotações reais do outro. Esconda segredos, tokens, abas privadas e qualquer coisa relacionada a clientes. Use uma foto de mesa normal, não um mockup polido.",
      postingNotes: "Enquadre como uma nota real de build: landing page no ar, produto em progresso e você construindo a engine de distribuição em público. Não dê a entender que o app completo está lançado.",
      imageAlt: "Laptop mostrando a landing page do Stride OS ao lado de notas ou código do projeto, com detalhes privados escondidos.",
      text: "Current Stride OS reality:\n\nlanding page is live\nproduct is still being built\nI am building the distribution system in public too\n\nIt feels early because it is.\n\nBut I want the story to compound while the product does."
    },
    {
      title: "A nota operacional bagunçada do fundador",
      recommendedSurface: "Post manual no perfil Stride OS",
      viralThesis: "Fotos não-polidas de trabalho real podem gerar mais confiança que conselho abstrato de build-in-public porque mostram que o fundador está de fato no trabalho.",
      evidence: "O Stride OS hoje é um projeto ativo com o produto principal ainda sendo construído, então o conteúdo mais honesto é a nota operacional por trás do produto.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Posts de build-in-public que mostram trabalho inacabado podem superar conselho genérico porque criam prova de trabalho e convidam builders pro processo.",
      whyNow: "O app principal do Stride OS ainda está em desenvolvimento, então o visual mais forte é a camada operacional honesta: notas, landing page, tarefas e decisões.",
      visualBrief: "Foto de um caderno ou anotação de laptop com as cinco perguntas que você quer que o Stride OS faça toda semana. Coloque a landing page ao fundo se possível.",
      captureInstruction: "Escreva as cinco perguntas no papel ou num app de notas. Mantenha o ar de inacabado do produto visível mas sem caos. Esconda informação privada.",
      postingNotes: "Faça a legenda ser sobre o insight por trás do produto, não um anúncio de feature.",
      imageAlt: "Notas do fundador mostrando cinco perguntas semanais de build-in-public com a landing page do Stride OS ao fundo.",
      text: "I do not have the full Stride OS app polished yet.\n\nBut the core idea keeps getting clearer:\n\nfounder updates should start from what actually changed that week.\n\nThe product is being built around that ritual."
    }
  ];

  return options[hashDate(today) % options.length];
}

function nextProfilePost(index, communitySignal) {
  const posts = [
    {
      viralThesis: "Posts em formato de checklist são salváveis e geram respostas, mas este aqui é amarrado a ritmo operacional em vez de conselho genérico de conteúdo.",
      evidence: "Mapeia direto pro Stride OS: dados do Stripe mais cinco perguntas semanais antes de gerar o update público.",
      trendSignal: "Build-in-public funciona melhor quando o update começa de evidência.",
      text: trimPost(`A weekly founder update should not start from \"what should I post?\"\n\nIt should start from:\n\nwhat shipped\nwhat moved\nwhat broke\nwhat changed in the numbers\nwhat I learned\n\nThat is the difference between content and operating in public.`)
    },
    {
      viralThesis: "O enquadramento anti-teatro atrai builders cansados de conselho genérico de build-in-public.",
      evidence: evidenceFor(communitySignal),
      sourceUrl: communitySignal.url,
      trendSignal: communitySignal.label,
      text: trimPost(`Build in public gets weird when it becomes performance.\n\nThe useful version is quieter:\n\nwhat changed\nwhat you tried\nwhat the numbers said\nwhat you are doing next\n\nThat is the story I want Stride OS to help founders tell.`)
    }
  ];
  return {
    type: "post",
    recommendedSurface: "Perfil Stride OS",
    ...posts[index % posts.length]
  };
}

async function writeAgentState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function trimPost(text) {
  if (text.length <= 280) return text;
  return `${text.slice(0, 276).trimEnd()}...`;
}

function getLocalDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function getLocalTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  return {
    hour: Number(part(parts, "hour")),
    minute: Number(part(parts, "minute"))
  };
}

function part(parts, type) {
  return parts.find((entry) => entry.type === type)?.value;
}

function hashDate(value) {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function isWithinScheduleWindow(local, hour, minute) {
  if (local.hour !== hour) return false;
  return local.minute >= minute && local.minute < minute + 5;
}
