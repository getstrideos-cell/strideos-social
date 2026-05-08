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
const redditAgentHour = Number(process.env.REDDIT_AGENT_HOUR || 11);
const redditAgentMinute = Number(process.env.REDDIT_AGENT_MINUTE || 0);
const xEvolutionHour = Number(process.env.X_EVOLUTION_HOUR || 18);
const xEvolutionMinute = Number(process.env.X_EVOLUTION_MINUTE || 0);
const schedulerIntervalMs = Number(process.env.AGENT_SCHEDULER_INTERVAL_MS || 60_000);
const replyMaxAgeHours = Number(process.env.REPLY_MAX_AGE_HOURS || 36);
const xSignalMaxAgeHours = Number(process.env.X_SIGNAL_MAX_AGE_HOURS || 96);
const memoryLookbackDays = Number(process.env.AGENT_MEMORY_LOOKBACK_DAYS || 45);
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
const weeklyMarketingDirective = {
  title: "Diretriz de Marketing da Semana",
  distributionBet:
    "Apostar no perfil pessoal do Guilherme no X como palco principal de prova: menos volume, mais narrativa humana, imagens reais e bastidores de quem saiu do emprego para construir Lumera Juris e Stride OS.",
  reasoning:
    "Os sinais recentes do próprio perfil mostram que posts com imagem e narrativa pessoal performam melhor. A história mais forte não é só Stride OS: é o Guilherme, advogado que pediu demissão, construindo legal AI no Brasil e um sistema para operar sua própria distribuição em público.",
  risk:
    "Se os posts soarem como promoção direta ou texto genérico de IA, vamos perder credibilidade. Manter tom humano, específico e honesto; usar Stride OS como parte da jornada, não como o único assunto.",
  requiredMix: [
    "Gerar apenas 2 posts de texto para publicação automática após aprovação.",
    "Gerar 1 Founder Moment com imagem/foto para publicação manual.",
    "Priorizar narrativa de demissão, bastidores reais, Lumera Juris, Stride OS e aprendizado de founder.",
    "Usar imagens sempre que houver uma história visual real: laptop, reunião, notas, landing, dashboard, workspace ou momento de construção.",
    "Evitar posts genéricos de build-in-public e evitar transformar todo conteúdo em pitch."
  ],
  directProductMentionMaxRatio: 0.35
};
const founderProfileContext = {
  profileHandle: "@guigdluche",
  profilePositioning: "Perfil pessoal do Guilherme Luche, não conta institucional do Stride OS.",
  bio: "Advogado que pediu demissão para construir o futuro da IA jurídica no Brasil. Co-founder da Lumera Juris e founder do Stride OS.",
  narrativeAssets: [
    "pedido de demissão para construir",
    "advogado entrando em legal AI",
    "Lumera Juris como empresa principal de legal AI",
    "Stride OS como sistema que ajuda o fundador a operar distribuição e build-in-public",
    "imagens reais performam melhor que texto abstrato"
  ]
};
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

  if (isWithinScheduleWindow(local, redditAgentHour, redditAgentMinute)) {
    results.push(await generateRedditPostPack({ reason: "schedule", now }));
  }

  if (isWithinScheduleWindow(local, xEvolutionHour, xEvolutionMinute)) {
    results.push(await generateXAccountEvolution({ reason: "schedule", now }));
  }

  return results;
}

export async function generateDailyGrowthPack({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.growthPack?.date === today) {
    return { agent: "growth-pack", status: "skipped", date: today, reason: "already-created" };
  }

  const queue = await readQueue();
  const memory = buildAgentMemory(queue, now);
  const board = await ensureFounderBoard(today, now);
  const signals = board?.signals || (await collectTrendSignals());
  const rawItems = selectNovelItems(buildGrowthPackItems(today, signals, board, memory), memory, 2);
  const enhancedItems = selectNovelItems(await enhanceGrowthPackWithOpenAI(rawItems, board, signals, memory), memory, 2);
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

export async function generateRedditPostPack({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.redditPostAgent?.date === today) {
    return { agent: "reddit-post-agent", status: "skipped", date: today, reason: "already-created" };
  }

  const queue = await readQueue();
  const memory = buildAgentMemory(queue, now);
  const signals = await collectRedditPlanningSignals();
  const rawItems = selectNovelItems(buildRedditPostItems(today, signals, memory), memory, 3);
  const enhancedItems = selectNovelItems(await enhanceRedditPostsWithOpenAI(rawItems, signals, memory), memory, 3);
  const items = enhancedItems.map((item) =>
    createQueueItem({
      ...item,
      status: "draft",
      source: "render-reddit-agent"
    })
  );

  await updateQueue((queue) => {
    queue.items.unshift(...items);
  });

  const latestState = await readAgentState();
  latestState.redditPostAgent = {
    date: today,
    reason,
    createdAt: now.toISOString(),
    count: items.length,
    summary: summarizeRedditOpportunity(signals),
    subreddits: redditSubreddits.slice(0, 6),
    signals: signals.slice(0, 8)
  };
  await writeAgentState(latestState);

  return { agent: "reddit-post-agent", status: "created", date: today, count: items.length };
}

export async function generateXAccountEvolution({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.xAccountEvolution?.date === today) {
    return { agent: "x-account-evolution", status: "skipped", date: today, reason: "already-created" };
  }

  const previous = state.xAccountEvolution;
  const report = await buildXAccountEvolutionReport(previous, now);
  const latestState = await readAgentState();
  latestState.xAccountEvolution = {
    ...report,
    date: today,
    reason,
    createdAt: now.toISOString()
  };
  await writeAgentState(latestState);

  return { agent: "x-account-evolution", status: report.available ? "created" : "limited", date: today };
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
    stage: "Perfil pessoal do Guilherme no X. Ele é advogado, pediu demissão para construir legal AI no Brasil, é co-founder da Lumera Juris e founder do Stride OS. Stride OS ainda tem landing page e sistema social/approval funcionando; produto principal em desenvolvimento.",
    signals,
    integrations: buildIntegrationStatus(signals),
    founderProfileContext,
    weeklyMarketingDirective,
    intelligence: hasOpenAI() ? "Aprimorado por OpenAI" : "Modo fallback",
    marketRadar: {
      title: "Radar de Mercado",
      summary: "Fundadores solo prestam atenção em histórias reais de risco, construção e aprendizado. A oportunidade agora é posicionar Guilherme como o founder construindo Lumera Juris e Stride OS em público, não como uma marca tentando parecer maior do que é.",
      topSignals: signals.slice(0, 4).map((signal) => ({
        label: signal.label,
        source: signal.source,
        url: signal.url || signal.targetPostUrl || "",
        evidence: evidenceFor(signal)
      })),
      implication: "Não escrever como conta institucional. Escrever como fundador real: demissão, bastidores, decisões, dúvidas, imagem quando houver prova visual e Stride OS como parte da jornada."
    },
    marketingDirector: {
      title: "Diretor de Marketing",
      distributionBet: weeklyMarketingDirective.distributionBet,
      reasoning: weeklyMarketingDirective.reasoning,
      recommendedActions: [
        ...weeklyMarketingDirective.requiredMix,
        `Usar como gancho da semana: ${primarySignal.label}.`
      ],
      experiment: {
        name: "Prova antes do produto",
        hypothesis: "Trabalho real e honesto em estágio inicial vai gerar respostas melhores do que afirmações polidas sobre o produto.",
        metric: "Respostas de fundadores, visitas ao perfil, seguidores qualificados, cliques na landing e performance de posts com imagem.",
        duration: "7 dias"
      },
      risk: weeklyMarketingDirective.risk
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
      todayFocus: "Executar a diretriz semanal do Marketing: menos posts, mais qualidade, dois textos fortes e um Founder Moment com imagem real.",
      decisions: [
        "Manter o Stride OS honesto sobre o estágio: landing page e projeto ativo, não lançamento completo do app.",
        "Tratar o perfil como Guilherme construindo Lumera Juris e Stride OS, não como conta institucional.",
        "Priorizar aprendizado de distribuição sobre amplitude de features nesta semana.",
        "Tratar respostas e posts em comunidade como pesquisa de mercado, não só engajamento.",
        "Manter a proporção de conteúdo educativo/operacional acima de 65% e referência direta ao produto abaixo de 35%.",
        "Quando houver boa história visual, preferir Founder Moment manual com imagem."
      ],
      nextMove: "Gerar 2 posts de texto fortes e 1 Founder Moment com imagem. Rejeitar qualquer draft que pareça pitch direto ou conselho genérico."
    },
    growthExperiment: {
      title: "Experimento de Crescimento",
      name: "Perfil pessoal com prova visual",
      channel: "Perfil pessoal do Guilherme no X",
      hypothesis: "Narrativa pessoal + imagem real vai gerar mais confiança e descoberta do que volume alto de posts de texto.",
      action: "Publicar dois posts de texto com narrativa humana e um Founder Moment manual com foto real de bastidor.",
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
        "Contexto do perfil: o X é o perfil pessoal do Guilherme Luche (@guigdluche), advogado que pediu demissão para construir o futuro da IA jurídica no Brasil. Ele é co-founder da Lumera Juris e founder do Stride OS.",
        "Stride OS hoje: landing page no ar, produto principal ainda em desenvolvimento, fluxo de aprovação social existe, produto no Stripe ainda não está pronto.",
        "Audiência: fundadores solo construindo SaaS em estágio inicial em público.",
        "Voz: humano, específico, founder real. Builder prático com leve toque visionário. Honesto, direto, sem hype genérico de IA.",
        "Sinal interno: posts com imagem e posts com narrativa da demissão/virada de carreira tendem a performar melhor. Reflita isso nas recomendações.",
        "Use apenas os signals fornecidos. Não invente métricas, clientes, receita, lançamentos ou features de produto.",
        "A Diretriz de Marketing da Semana tem prioridade sobre recomendações genéricas. Preserve o mix: X como palco principal, reply em conta grande, pergunta na comunidade build-in-public, reaproveitamento em Reddit e menos de 30% de referência direta ao produto.",
        "Escreva todo o conteúdo em PORTUGUÊS BRASILEIRO. O texto que vai para os posts é tratado em outra etapa, aqui é apenas conteúdo estratégico para o fundador ler.",
        "Retorne orientação estratégica concisa que possa alimentar diretamente conteúdo, respostas, posts em comunidade e decisões de roadmap."
      ].join("\n"),
      input: JSON.stringify({
        stage: board.stage,
        integrations: board.integrations,
        founderProfileContext: board.founderProfileContext,
        weeklyMarketingDirective: board.weeklyMarketingDirective,
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

async function enhanceGrowthPackWithOpenAI(items, board, signals, memory = emptyAgentMemory()) {
  if (!hasOpenAI()) return items;

  try {
    const enhanced = await createStructuredJson({
      name: "growth_pack",
      schema: growthPackSchema,
      maxOutputTokens: 5000,
      instructions: [
        "Você é o estrategista de conteúdo do perfil pessoal do Guilherme Luche.",
        "Reescreva ou melhore os itens de draft fornecidos usando o contexto do Conselho do Founder.",
        "IMPORTANTE: o campo `text` (texto público que vai pro X) DEVE permanecer em INGLÊS — é o post final que vai pro Twitter/X.",
        "Todos os outros campos auxiliares (recommendedSurface, viralThesis, evidence, trendSignal) devem ser escritos em PORTUGUÊS BRASILEIRO — eles são lidos pelo fundador no painel, não publicados.",
        "Mantenha cada texto público (`text`) abaixo de 280 caracteres.",
        "A saída deve conter exatamente dois itens.",
        "Siga a Diretriz de Marketing da Semana como regra principal.",
        "Os dois itens devem ser posts de texto para o perfil pessoal @guigdluche, tipo post e formato standard, aptos a publicar automaticamente após aprovação.",
        "Não gere replies, posts de comunidade ou Reddit neste pacote. Esses canais têm agentes separados.",
        "Contexto obrigatório: Guilherme é advogado, pediu demissão para construir o futuro da IA jurídica no Brasil, constrói Lumera Juris e Stride OS, e quer um tom mais humano.",
        "Priorize especificidade: bastidores reais, risco pessoal, aprendizado de founder, demissão, legal AI no Brasil, construir duas empresas, e Stride OS como parte da jornada.",
        "Não repita nenhum texto, post-alvo, sourceUrl ou ângulo já existente na memória fornecida.",
        "Não finja que o Stride OS está totalmente lançado. Atualmente tem só uma landing page e o projeto em desenvolvimento.",
        "No máximo um dos dois itens pode citar Stride OS diretamente. O outro deve ser mais pessoal/operacional.",
        "Sem hashtags a não ser que sejam genuinamente necessárias. Sem hype com cara de IA. Sem métricas falsas."
      ].join("\n"),
      input: JSON.stringify({
        board: {
          stage: board?.stage,
          marketRadar: board?.marketRadar,
          marketingDirector: board?.marketingDirector,
          productDirector: board?.productDirector,
          chiefOfStaff: board?.chiefOfStaff,
          growthExperiment: board?.growthExperiment,
          founderProfileContext: board?.founderProfileContext || founderProfileContext,
          weeklyMarketingDirective: board?.weeklyMarketingDirective || weeklyMarketingDirective
        },
        signals: compactSignals(signals).slice(0, 8),
        avoid: compactAgentMemory(memory),
        draftItems: items
      })
    });

    return enhanced.items.slice(0, 2).map((item, index) => {
      const original = items[index] || {};
      return {
        ...original,
        type: "post",
        format: "standard",
        requiresManualPublish: false,
        recommendedSurface: item.recommendedSurface || "Perfil pessoal do Guilherme no X",
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

async function enhanceRedditPostsWithOpenAI(items, signals, memory = emptyAgentMemory()) {
  if (!hasOpenAI()) return items;

  try {
    const enhanced = await createStructuredJson({
      name: "reddit_post_pack",
      schema: redditPackSchema,
      maxOutputTokens: 5000,
      instructions: [
        "Você é o agente de Reddit do Stride OS.",
        "Seu trabalho é estudar sinais de subreddits de founders/SaaS e sugerir posts que pareçam nativos do Reddit, não anúncios.",
        "O texto público (`text`) e o título (`title`) devem estar em INGLÊS.",
        "Campos auxiliares como evidence, viralThesis e trendSignal devem estar em PORTUGUÊS BRASILEIRO.",
        "Cada post deve ser útil mesmo se ninguém clicar em link. Não coloque link da landing no corpo por padrão.",
        "Priorize perguntas, aprendizados honestos e dilemas reais de founder. Evite tom de thread do X, hype de IA, CTA agressivo e autopromoção.",
        "Stride OS ainda está em desenvolvimento: landing page no ar, produto principal não lançado. Pode mencionar isso como contexto honesto em no máximo um item.",
        "Retorne exatamente três sugestões. Não repita textos, ângulos ou URLs já usados na memória."
      ].join("\n"),
      input: JSON.stringify({
        subreddits: redditSubreddits,
        signals: compactSignals(signals).slice(0, 10),
        avoid: compactAgentMemory(memory),
        draftItems: items
      })
    });

    return enhanced.items.slice(0, 3).map((item, index) => {
      const original = items[index] || {};
      const subreddit = item.subreddit || subredditFromSurface(original.recommendedSurface) || "SaaS";
      return {
        ...original,
        type: "post",
        format: "community-post",
        requiresManualPublish: true,
        title: trimRedditTitle(item.title || original.title || ""),
        recommendedSurface: `Reddit: r/${subreddit.replace(/^r\//, "")}`,
        viralThesis: item.viralThesis || original.viralThesis,
        evidence: item.evidence || original.evidence,
        sourceUrl: item.sourceUrl || original.sourceUrl || "",
        trendSignal: item.trendSignal || original.trendSignal,
        text: trimRedditPost(item.text || original.text || "")
      };
    });
  } catch (error) {
    console.warn("OpenAI reddit post enhancement failed:", error.message);
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

function buildGrowthPackItems(today, signals, board, memory = emptyAgentMemory()) {
  const primarySignal = signals[0] || { label: "agentes de IA estão deixando fundadores solo mais rápidos", source: "fallback" };
  const performanceSignal =
    signals.find((signal) => signal.source === "x-performance") ||
    signals.find((signal) => signal.kind === "internal-feedback") ||
    primarySignal;

  const items = [
    {
      type: "post",
      format: "standard",
      recommendedSurface: "Perfil pessoal do Guilherme no X",
      viralThesis: "Narrativa humana de virada de carreira é mais forte que post institucional; conecta demissão, risco e construção real.",
      evidence: "O perfil agora é pessoal e posts com narrativa da demissão/virada performam melhor que posts genéricos sobre build-in-public.",
      sourceUrl: "https://x.com/guigdluche",
      trendSignal: "Fundadores respondem a histórias específicas de risco e construção, especialmente quando há contexto pessoal.",
      text: trimPost(`I used to think quitting my job was the big scary decision.\n\nIt was not.\n\nThe harder part is waking up the next day and realizing there is no script anymore.\n\nJust customers to understand, products to build, and a story you have to earn in public.`)
    },
    {
      type: "post",
      format: "standard",
      recommendedSurface: "Perfil pessoal do Guilherme no X",
      viralThesis: "Conecta Lumera Juris e Stride OS sem parecer pitch: duas empresas como laboratório real de founder.",
      evidence: evidenceFor(performanceSignal),
      sourceUrl: performanceSignal.url || "https://getstrideos.com",
      trendSignal: performanceSignal.label || primarySignal.label,
      text: trimPost(`I am building Lumera Juris and Stride OS at the same time.\n\nOne is the company.\nThe other is becoming the operating layer I wish I had while building it.\n\nThat is the strange advantage of building in public:\nyour pain becomes product research.`)
    }
  ];

  return items.map((item) => ({ ...item, generatedForDate: today }));
}

async function collectRedditPlanningSignals() {
  const signals = [];
  signals.push(...(await collectRedditSignals()));
  signals.push(...(await collectGoogleAnalyticsSignals()));
  signals.push(...(await collectInternalFeedbackSignals()));

  if (signals.length === 0) {
    signals.push(
      {
        kind: "reddit",
        source: "reddit-fallback",
        label: "Founders respond to specific operating questions better than generic startup advice",
        url: "https://www.reddit.com/r/SaaS/",
        metrics: {},
        score: 1
      },
      {
        kind: "reddit",
        source: "reddit-fallback",
        label: "Posts asking how other founders solve a recurring workflow tend to invite detailed replies",
        url: "https://www.reddit.com/r/Entrepreneur/",
        metrics: {},
        score: 1
      }
    );
  }

  return dedupeSignals(signals).sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 12);
}

function buildRedditPostItems(today, signals, memory = emptyAgentMemory()) {
  const primary = signals.find((signal) => signal.source === "reddit") || signals[0] || {};
  const second = signals.find((signal) => signal !== primary && signal.source === "reddit") || signals[1] || primary;
  const analytics = signals.find((signal) => signal.kind === "landing-analytics");
  const primarySubreddit = subredditFromSignal(primary) || "SaaS";
  const secondSubreddit = subredditFromSignal(second) || "Entrepreneur";

  const items = [
    {
      type: "post",
      format: "community-post",
      requiresManualPublish: true,
      title: "How do you make weekly founder updates useful instead of performative?",
      recommendedSurface: `Reddit: r/${primarySubreddit}`,
      viralThesis: "Pergunta operacional ampla o bastante para gerar respostas, mas específica o bastante para atrair fundadores que já tentaram build-in-public.",
      evidence: evidenceFor(primary),
      sourceUrl: primary.url || `https://www.reddit.com/r/${primarySubreddit}/`,
      trendSignal: primary.label || "Fundadores querem updates reais, não teatro de conteúdo.",
      text: trimRedditPost(`I am trying to understand how solo founders make weekly updates actually useful.\n\nMost build-in-public advice says \"share the journey\", but that gets vague fast.\n\nWhen your week is messy, what do you usually post?\n\n- what shipped\n- what broke\n- a metric\n- a lesson\n- a screenshot\n- the next decision\n\nThe part I am curious about: what makes an update worth reading instead of just being founder content?`)
    },
    {
      type: "post",
      format: "community-post",
      requiresManualPublish: true,
      title: "Do you track a weekly founder operating note?",
      recommendedSurface: `Reddit: r/${secondSubreddit}`,
      viralThesis: "Enquadra Stride OS como pesquisa de produto sem vender a ferramenta; deve atrair respostas sobre workflow real.",
      evidence: evidenceFor(second),
      sourceUrl: second.url || `https://www.reddit.com/r/${secondSubreddit}/`,
      trendSignal: second.label || "Comunidades respondem melhor a perguntas de processo do que a anúncios.",
      text: trimRedditPost(`For founders running a small SaaS: do you keep any kind of weekly operating note?\n\nI mean something simple like:\n\n- what changed in the product\n- what moved in the numbers\n- what users said\n- what you learned\n- what you are doing next\n\nI am building around this problem and I am trying not to overcomplicate it. Curious if people actually do this today, or if most updates are reconstructed from memory when it is time to post.`)
    },
    {
      type: "post",
      format: "community-post",
      requiresManualPublish: true,
      title: analytics ? "Landing page traffic is useful, but it does not tell me what to build next" : "What do you wish your weekly startup update forced you to notice?",
      recommendedSurface: "Reddit: r/startups",
      viralThesis: "Conecta analytics e decisão de produto: assunto natural para founders, menos promocional que falar da landing.",
      evidence: analytics ? evidenceFor(analytics) : "O Stride OS ainda está em fase de landing/projeto, então a pergunta certa é sobre aprendizado e sinal, não venda.",
      sourceUrl: analytics?.url || "https://www.reddit.com/r/startups/",
      trendSignal: analytics?.label || "Founders need sharper weekly signals before they can tell a useful public story.",
      text: trimRedditPost(`One thing I keep noticing while building: analytics can tell you what happened, but not always what to say or what to build next.\n\nA landing page can show visits, sources, and engagement.\n\nBut the harder founder question is:\n\nwhat changed this week that is actually worth explaining?\n\nIf you write weekly updates for a startup, what signal do you wish the update forced you to look at every time?`)
    }
  ];

  return items.map((item) => ({ ...item, generatedForDate: today }));
}

function summarizeRedditOpportunity(signals) {
  const redditSignals = signals.filter((signal) => signal.source === "reddit");
  if (redditSignals.length === 0) {
    return "Sem leitura forte do Reddit agora. O agente usou fallback: perguntas operacionais para fundadores, sem pitch direto.";
  }
  const top = redditSignals[0];
  const subreddit = subredditFromSignal(top) || "SaaS";
  return `Melhor oportunidade: r/${subreddit}. O sinal mais forte foi "${top.label}", com ${top.metrics?.comments || 0} comentários e score ${top.metrics?.score || top.score || 0}.`;
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
        const ageHours = getAgeHours(tweet.created_at);
        const relevant = isRelevantTweet(text);
        if (!relevant) continue;
        if (ageHours !== null && ageHours > xSignalMaxAgeHours) continue;

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
          createdAt: tweet.created_at || "",
          ageHours,
          isFreshForReply: ageHours !== null && ageHours <= replyMaxAgeHours,
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

async function buildXAccountEvolutionReport(previous, now) {
  const tokenState = await getFreshXTokenState();
  if (!tokenState.accessToken) {
    return {
      available: false,
      summary: "X não está disponível para leitura agora. Conecte ou regenere os tokens para medir evolução da conta.",
      metrics: {},
      deltas: {},
      topPosts: [],
      recommendations: ["Verificar se X_USER_ACCESS_TOKEN e X_REFRESH_TOKEN continuam válidos no Render."]
    };
  }

  try {
    const me = await xFetchJson(
      "https://api.x.com/2/users/me?user.fields=public_metrics,username,name,created_at",
      tokenState
    );
    const user = me?.data || {};
    const metrics = user.public_metrics || {};
    const queue = await readQueue();
    const published = queue.items
      .filter((item) => item.status === "published" && item.xPostId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 20);

    const topPosts = await fetchPublishedPostMetrics(published, tokenState);
    const snapshot = {
      username: user.username || "",
      name: user.name || "",
      followers: Number(metrics.followers_count || 0),
      following: Number(metrics.following_count || 0),
      posts: Number(metrics.tweet_count || 0),
      listed: Number(metrics.listed_count || 0)
    };
    const deltas = {
      followers: snapshot.followers - Number(previous?.metrics?.followers || snapshot.followers),
      following: snapshot.following - Number(previous?.metrics?.following || snapshot.following),
      posts: snapshot.posts - Number(previous?.metrics?.posts || snapshot.posts),
      listed: snapshot.listed - Number(previous?.metrics?.listed || snapshot.listed)
    };

    const bestPost = topPosts[0];
    const summary = [
      `@${snapshot.username || "conta"} está com ${snapshot.followers} seguidores`,
      deltas.followers === 0 ? "sem variação de seguidores desde o último snapshot" : `${signed(deltas.followers)} seguidores desde o último snapshot`,
      bestPost ? `melhor post recente: ${bestPost.score} pontos de engajamento` : "ainda sem posts publicados com ID do X para comparar"
    ].join("; ");

    return {
      available: true,
      summary,
      metrics: snapshot,
      deltas,
      topPosts,
      recommendations: buildXEvolutionRecommendations(deltas, topPosts, now)
    };
  } catch (error) {
    console.warn("Could not build X account evolution report:", error.message);
    return {
      available: false,
      summary: `Não foi possível ler a evolução da conta no X agora: ${error.message}`,
      metrics: previous?.metrics || {},
      deltas: {},
      topPosts: previous?.topPosts || [],
      recommendations: ["Tentar novamente mais tarde ou verificar permissões tweet.read/users.read no X."]
    };
  }
}

async function fetchPublishedPostMetrics(items, tokenState) {
  const ids = items.map((item) => item.xPostId).filter(Boolean);
  if (ids.length === 0) return [];

  const tweets = await xFetchJson(
    `https://api.x.com/2/tweets?ids=${encodeURIComponent(ids.join(","))}&tweet.fields=created_at,public_metrics,text`,
    tokenState
  );
  const byId = new Map((tweets.data || []).map((tweet) => [tweet.id, tweet]));

  return items
    .map((item) => {
      const tweet = byId.get(item.xPostId);
      if (!tweet) return null;
      const metrics = tweet.public_metrics || {};
      const score =
        Number(metrics.like_count || 0) +
        Number(metrics.reply_count || 0) * 4 +
        Number(metrics.retweet_count || 0) * 3 +
        Number(metrics.quote_count || 0) * 3;
      return {
        id: tweet.id,
        url: `https://x.com/i/web/status/${tweet.id}`,
        text: normalizeTweetText(tweet.text || item.text || "").slice(0, 220),
        createdAt: tweet.created_at || item.updatedAt || "",
        metrics,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 5);
}

function buildXEvolutionRecommendations(deltas, topPosts, now) {
  const recommendations = [];
  const bestPost = topPosts[0];

  if (deltas.followers > 0) {
    recommendations.push(`Dobrar no formato que trouxe crescimento: revisar o melhor post recente e criar uma variação no próximo pacote.`);
  } else {
    recommendations.push("Priorizar replies em contas grandes e perguntas de comunidade para gerar descoberta antes de pedir cliques.");
  }

  if (bestPost?.metrics?.reply_count > 0) {
    recommendations.push("Transformar respostas do melhor post em pesquisa de mercado: quais objeções, frases e dores apareceram?");
  } else {
    recommendations.push("Testar posts com pergunta operacional clara no final para aumentar respostas qualificadas de fundadores.");
  }

  recommendations.push(`Próximo snapshot automático: ${getLocalDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000))}.`);
  return recommendations;
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
    type: { type: "string", enum: ["post"] },
    format: { type: "string", enum: ["standard"] },
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
      minItems: 2,
      maxItems: 2,
      items: growthPackItemSchema
    }
  },
  required: ["items"]
};

const redditPackItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subreddit: { type: "string" },
    title: { type: "string" },
    recommendedSurface: { type: "string" },
    viralThesis: { type: "string" },
    evidence: { type: "string" },
    sourceUrl: { type: "string" },
    trendSignal: { type: "string" },
    text: { type: "string" }
  },
  required: ["subreddit", "title", "recommendedSurface", "viralThesis", "evidence", "sourceUrl", "trendSignal", "text"]
};

const redditPackSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: redditPackItemSchema
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
      title: "A mesa depois da demissão",
      recommendedSurface: "Post manual no perfil pessoal do Guilherme",
      viralThesis: "Imagem real + narrativa de demissão é o ativo mais humano do perfil e diferencia o conteúdo de posts genéricos sobre IA.",
      evidence: "O perfil performa melhor quando mistura foto real, bastidor e a história de ter saído do emprego para construir.",
      sourceUrl: "https://x.com/guigdluche",
      trendSignal: "Fundadores respondem a risco pessoal e prova visual de trabalho real.",
      whyNow: "A conta acabou de virar perfil pessoal de founder. Este é o momento certo para reforçar quem é Guilherme antes de tentar vender Stride OS.",
      visualBrief: "Tire uma foto simples da sua mesa/laptop no momento real de trabalho. Pode mostrar Lumera Juris, Stride OS, anotações ou tarefas abertas, mas sem dados sensíveis.",
      captureInstruction: "Use luz natural se possível. Não faça mockup polido. A imagem deve parecer um momento real de construção depois da demissão, com tela/notas suficientes para dar contexto.",
      postingNotes: "Legenda deve ser sobre a escolha de sair do emprego e construir, não sobre vender produto. Stride OS pode aparecer como parte da rotina.",
      imageAlt: "Mesa de trabalho do fundador com laptop e anotações de Lumera Juris e Stride OS, sem dados sensíveis visíveis.",
      text: "The part I did not expect after quitting my job:\n\nthere is no clean line between building the product and becoming the person who can build it.\n\nSome days are code.\nSome days are sales.\nSome days are just learning how to not disappear."
    },
    {
      title: "Legal AI no Brasil, em construção",
      recommendedSurface: "Post manual no perfil pessoal do Guilherme",
      viralThesis: "Foto de bastidor da Lumera Juris conecta a autoridade de advogado com a construção de IA jurídica, uma narrativa mais forte que falar só de ferramenta.",
      evidence: "A bio atual combina Lumera Juris e Stride OS; a história principal é founder de legal AI construindo em público.",
      sourceUrl: "https://lumerajuris.com.br",
      trendSignal: "Legal AI + founder journey cria um ângulo próprio e mais defensável.",
      whyNow: "O perfil precisa ensinar o público a acompanhar duas frentes: empresa principal de legal AI e sistema de distribuição/operating layer.",
      visualBrief: "Tire uma foto do notebook com alguma tela pública/segura da Lumera Juris ou uma anotação sobre legal AI no Brasil. Stride OS pode aparecer em uma aba secundária.",
      captureInstruction: "Esconda casos, clientes, documentos jurídicos e qualquer dado privado. Mostre só contexto público, tarefa genérica ou anotação criada para a foto.",
      postingNotes: "Legenda deve mostrar o contraste: advogado deixando carreira tradicional para construir infraestrutura de IA jurídica no Brasil.",
      imageAlt: "Laptop com anotações sobre legal AI no Brasil e trabalho de founder, sem informações sensíveis.",
      text: "I left law to build legal AI in Brazil.\n\nThat sentence sounds cleaner than the actual process.\n\nThe real version is messier:\nlearning product, sales, engineering, distribution, and still trying to keep the legal problem honest."
    },
    {
      title: "Stride OS como sistema pessoal",
      recommendedSurface: "Post manual no perfil pessoal do Guilherme",
      viralThesis: "Mostra Stride OS como ferramenta nascida da própria dor do fundador, não como app abstrato.",
      evidence: "A melhor história do Stride OS é que ele está sendo criado para resolver a distribuição do próprio Guilherme enquanto ele constrói Lumera Juris.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Produtos que nascem de uma dor pública e visível tendem a parecer mais confiáveis.",
      whyNow: "A nova estratégia do perfil permite mostrar Stride OS como bastidor da operação pessoal, com foto real.",
      visualBrief: "Tire uma foto com o dashboard do Stride OS Social ou a landing getstrideos.com aberta junto de um post/rascunho em inglês. Não mostre tokens, senhas ou painéis sensíveis.",
      captureInstruction: "Enquadre como bastidor de distribuição, não como lançamento de produto. Se aparecer métrica, garanta que pode ser pública.",
      postingNotes: "Legenda deve explicar que Stride OS nasceu para transformar progresso real em updates melhores enquanto a empresa principal é construída.",
      imageAlt: "Tela com Stride OS ou rascunhos de build-in-public abertos em um laptop, sem dados privados.",
      text: "Stride OS started as a product idea.\n\nNow it is also becoming my own operating layer for building in public.\n\nThat feels like the right order:\nuse the pain first,\nthen build the product around what keeps hurting."
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
    },
    {
      viralThesis: "Contraste entre ferramenta e ritual ajuda a posicionar o Stride OS como sistema operacional do fundador, não só app de conteúdo.",
      evidence: "O Founder Board já cruza sinais de X, analytics, comunidade e fila interna antes de sugerir uma ação.",
      trendSignal: "Founders estão buscando sistemas, não mais uma lista de tarefas de conteúdo.",
      text: trimPost(`I keep noticing the same founder problem:\n\nshipping creates facts\nbut posting needs a story\n\nStride OS is becoming the layer between those two things.\n\nNot a content calendar.\nA weekly operating ritual.`)
    },
    {
      viralThesis: "Post de bastidor sobre o produto incompleto aumenta confiança e reduz a sensação de marketing prematuro.",
      evidence: "A landing está no ar, mas o produto principal ainda está sendo construído; esse é o estágio honesto mais forte para narrativa.",
      trendSignal: "Proof-of-work em estágio inicial tende a gerar conversas melhores que anúncio polido.",
      text: trimPost(`The product is not polished yet.\n\nThat is exactly why I want to build in public properly.\n\nIf Stride OS works, it should help me turn messy weekly progress into a clear update before the product feels launch-ready.`)
    },
    {
      viralThesis: "Pergunta operacional convida replies de fundadores e coleta pesquisa de mercado sem parecer pitch.",
      evidence: evidenceFor(communitySignal),
      sourceUrl: communitySignal.url,
      trendSignal: communitySignal.label,
      text: trimPost(`Curious how other solo founders do this:\n\nwhen a week is messy, what do you post?\n\nThe shipped thing?\nThe lesson?\nThe metric?\nThe honest blocker?\n\nI am building around this problem and the answer is less obvious than I expected.`)
    },
    {
      viralThesis: "Nomeia uma dor concreta: consistência sem parecer máquina de conteúdo.",
      evidence: "A fila interna mistura posts, replies, comunidade e founder moments; a dor é decidir o que vale publicar, não apenas gerar texto.",
      trendSignal: "A distribuição de fundador está migrando de volume para qualidade de sinal.",
      text: trimPost(`The hard part of building in public is not writing one update.\n\nIt is staying consistent without becoming a content machine.\n\nThat is the line I am trying to design Stride OS around.`)
    },
    {
      viralThesis: "Mostra o produto como conselho de diretores de IA, um ângulo mais memorável que gerador de tweets.",
      evidence: "O Stride OS já tem Radar de Mercado, Diretor de Marketing, Diretor de Produto e Growth Experiment alimentando drafts.",
      trendSignal: "AI agents are moving from one-off prompts to operating systems for solo founders.",
      text: trimPost(`The more I build Stride OS, the less I think of it as a posting tool.\n\nIt is closer to a tiny operating team:\n\nmarket radar\nmarketing director\nproduct director\ncontent agents\n\nAll pointing at one question: what should the founder do next?`)
    }
  ];
  return {
    type: "post",
    recommendedSurface: "Perfil Stride OS",
    ...posts[index % posts.length]
  };
}

function buildAgentMemory(queue, now = new Date()) {
  const memory = emptyAgentMemory();
  const cutoff = now.getTime() - memoryLookbackDays * 24 * 60 * 60 * 1000;

  for (const item of queue.items || []) {
    const timestamp = new Date(item.updatedAt || item.createdAt || item.manualPublishedAt || 0).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff) continue;

    rememberItem(item, memory);
  }

  return memory;
}

function emptyAgentMemory() {
  return {
    replyToPostIds: new Set(),
    sourceUrls: new Set(),
    textFingerprints: new Set(),
    ideaFingerprints: new Set(),
    publicTexts: []
  };
}

function selectNovelItems(items, memory, limit) {
  const selected = [];
  const localMemory = cloneAgentMemory(memory);

  for (const item of items) {
    if (selected.length >= limit) break;
    if (isDuplicateItem(item, localMemory)) continue;
    selected.push(item);
    rememberItem(item, localMemory);
  }

  return selected;
}

function isDuplicateItem(item, memory) {
  if (item.replyToPostId && memory.replyToPostIds.has(String(item.replyToPostId))) return true;

  const url = String(item.sourceUrl || item.targetPostUrl || "").toLowerCase();
  if (url && memory.sourceUrls.has(url)) return true;

  if (item.text) {
    const fingerprint = fingerprintText(item.text);
    if (memory.textFingerprints.has(fingerprint)) return true;
    if (memory.publicTexts.some((text) => textSimilarity(text, item.text) >= 0.68)) return true;
  }

  const ideaText = [item.viralThesis, item.trendSignal].filter(Boolean).join(" ");
  if (ideaText && memory.ideaFingerprints.has(fingerprintText(ideaText))) return true;

  return false;
}

function rememberItem(item, memory) {
  if (item.replyToPostId) memory.replyToPostIds.add(String(item.replyToPostId));

  for (const url of [item.sourceUrl, item.targetPostUrl]) {
    if (url) memory.sourceUrls.add(String(url).toLowerCase());
  }

  if (item.text) {
    memory.textFingerprints.add(fingerprintText(item.text));
    memory.publicTexts.push(item.text);
  }

  const ideaText = [item.viralThesis, item.trendSignal].filter(Boolean).join(" ");
  if (ideaText) memory.ideaFingerprints.add(fingerprintText(ideaText));
}

function cloneAgentMemory(memory) {
  return {
    replyToPostIds: new Set(memory.replyToPostIds),
    sourceUrls: new Set(memory.sourceUrls),
    textFingerprints: new Set(memory.textFingerprints),
    ideaFingerprints: new Set(memory.ideaFingerprints),
    publicTexts: [...memory.publicTexts]
  };
}

function compactAgentMemory(memory) {
  return {
    usedReplyToPostIds: [...memory.replyToPostIds].slice(-50),
    usedSourceUrls: [...memory.sourceUrls].slice(-50),
    recentPublicTexts: memory.publicTexts.slice(-20)
  };
}

function fingerprintText(text) {
  return meaningfulWords(text).slice(0, 22).join(" ");
}

function textSimilarity(left, right) {
  const leftWords = new Set(meaningfulWords(left));
  const rightWords = new Set(meaningfulWords(right));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;

  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  return intersection / union;
}

function meaningfulWords(text) {
  const stopwords = new Set([
    "the",
    "and",
    "that",
    "this",
    "with",
    "from",
    "para",
    "como",
    "uma",
    "que",
    "por",
    "com",
    "mais",
    "when",
    "what",
    "your",
    "you",
    "are",
    "not",
    "still",
    "founder",
    "founders",
    "stride",
    "strideos"
  ]);
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopwords.has(word));
}

function getAgeHours(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return (Date.now() - timestamp) / (60 * 60 * 1000);
}

async function writeAgentState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function trimPost(text) {
  if (text.length <= 280) return text;
  return `${text.slice(0, 276).trimEnd()}...`;
}

function trimRedditPost(text) {
  if (text.length <= 1800) return text;
  return `${text.slice(0, 1796).trimEnd()}...`;
}

function trimRedditTitle(text) {
  const clean = normalizeTweetText(text || "");
  if (clean.length <= 180) return clean;
  return `${clean.slice(0, 177).trimEnd()}...`;
}

function subredditFromSignal(signal = {}) {
  return subredditFromSurface(`${signal.label || ""} ${signal.url || ""}`);
}

function subredditFromSurface(value = "") {
  const match = String(value).match(/r\/([A-Za-z0-9_]+)/i);
  return match?.[1] || "";
}

function signed(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
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
