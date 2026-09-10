import './styles.css';
import {
  connectInvestigation,
  decideApproval,
  startInvestigation,
  type InvestigationSnapshot,
} from './api.js';
import { BrowserSpeechInput, BrowserSpeechOutput, type VoiceInputState } from './voice.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('BIMO application root is missing.');

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="BIMO home"><span class="brand-mark">B</span><span>BIMO</span></a>
      <div class="connection"><span class="status-dot"></span><span id="connection-label">READY</span></div>
    </header>
    <main class="workspace">
      <section class="command-band" aria-labelledby="workspace-title">
        <div class="command-copy">
          <p class="eyebrow">AUTONOMOUS TECHNICAL OPERATIONS</p>
          <h1 id="workspace-title">Tell BIMO what is broken.</h1>
          <p class="subcopy">BIMO will gather evidence, explain its reasoning, and ask before consequential changes.</p>
        </div>
        <div class="voice-column">
          <button class="voice-orb" id="voice-button" type="button" aria-label="Start voice input" aria-pressed="false">
            <span class="orb-core" aria-hidden="true"></span><span class="orb-label">SPEAK</span>
          </button>
          <span class="voice-hint" id="voice-hint">Voice input available when supported</span>
        </div>
        <form class="fallback-form" id="problem-form">
          <label for="problem-input">Problem</label>
          <div class="input-row">
            <input id="problem-input" name="problem" type="text" autocomplete="off" placeholder="e.g. My deployment is failing" required />
            <button type="submit">Investigate <span aria-hidden="true">↗</span></button>
          </div>
        </form>
        <div class="transcript" aria-live="polite"><div class="transcript-line"><span class="transcript-speaker">USER</span><span id="transcript-text">No problem recorded yet.</span></div><div class="transcript-line bimo-line"><span class="transcript-speaker">BIMO</span><span id="bimo-transcript">Ready when you are.</span></div></div>
      </section>

      <section class="investigation-layout" aria-label="Current investigation">
        <div class="timeline-panel panel">
          <div class="panel-heading"><div><p class="eyebrow">LIVE TRACE</p><h2>Investigation</h2></div><span class="state-badge" id="state-badge">IDLE</span></div>
          <div class="timeline" id="timeline"><div class="empty-state">Start an investigation to see BIMO's live trace.</div></div>
        </div>
        <aside class="side-stack">
          <section class="panel evidence-panel"><div class="panel-heading"><div><p class="eyebrow">SIGNALS</p><h2>Evidence</h2></div><span class="count" id="evidence-count">0</span></div><div id="evidence-list" class="evidence-list"><div class="empty-state">Evidence will appear here.</div></div></section>
          <section class="panel approval-panel" id="approval-panel" hidden><div class="panel-heading"><div><p class="eyebrow">ACTION REQUIRED</p><h2>Approval</h2></div><span class="risk-badge" id="approval-risk">CONSEQUENTIAL</span></div><p class="approval-reason" id="approval-reason"></p><div class="approval-meta" id="approval-meta"></div><div class="approval-actions"><button class="deny" id="deny-button" type="button">Deny</button><button class="approve" id="approve-button" type="button">Approve <span aria-hidden="true">→</span></button></div></section>
        </aside>
      </section>

      <section class="resolution panel" id="resolution-panel" hidden><div class="resolution-copy"><p class="eyebrow" id="resolution-eyebrow">RESOLUTION</p><h2 id="resolution-title"></h2><p id="resolution-summary"></p></div><div class="resolution-stats"><div><span id="actions-count">0</span><small>ACTIONS</small></div><div><span id="recovery-count">0</span><small>RECOVERIES</small></div></div></section>
    </main>
    <footer class="footer"><span>ONE RUNTIME · BOUNDED ACTIONS · EXPLICIT APPROVAL</span><span id="support-label">TEXT FALLBACK ENABLED</span></footer>
  </div>`;

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element ${selector}`);
  return element;
};

const voiceInput = new BrowserSpeechInput();
const voiceOutput = new BrowserSpeechOutput();
let activeStream: EventSource | null = null;
let activeInvestigationId: string | null = null;
let latestSnapshot: InvestigationSnapshot | null = null;
let voiceBusy = false;

const connectionLabel = $('#connection-label');
const stateBadge = $('#state-badge') as HTMLElement;
const voiceButton = $('#voice-button') as HTMLButtonElement;
const voiceHint = $('#voice-hint');
const transcriptText = $('#transcript-text');
const bimoTranscript = $('#bimo-transcript');
const form = $('#problem-form') as HTMLFormElement;
const problemInput = $('#problem-input') as HTMLInputElement;
const timeline = $('#timeline');
const evidenceList = $('#evidence-list');
const evidenceCount = $('#evidence-count');
const approvalPanel = $('#approval-panel') as HTMLElement;
const approvalReason = $('#approval-reason');
const approvalMeta = $('#approval-meta');
const resolutionPanel = $('#resolution-panel') as HTMLElement;
const resolutionEyebrow = $('#resolution-eyebrow');
const resolutionTitle = $('#resolution-title');
const resolutionSummary = $('#resolution-summary');
const actionsCount = $('#actions-count');
const recoveryCount = $('#recovery-count');

voiceHint.textContent = voiceInput.supported ? 'Browser microphone ready' : 'Use the text field on this device';
$('#support-label').textContent = voiceOutput.supported ? 'VOICE OUTPUT READY' : 'TEXT OUTPUT ONLY';

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));

const statusLabel = (status: string): string => status.replaceAll('_', ' ');

const renderTimeline = (snapshot: InvestigationSnapshot): void => {
  if (!snapshot.events.length) {
    timeline.innerHTML = '<div class="empty-state">Waiting for the first runtime event.</div>';
    return;
  }
  timeline.innerHTML = snapshot.events.map((event, index) => {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const detail = typeof data.reasoningSummary === 'string' ? data.reasoningSummary
      : typeof data.summary === 'string' ? data.summary
        : typeof data.reason === 'string' ? data.reason
          : typeof data.toolName === 'string' ? data.toolName : '';
    return `<div class="timeline-item ${index === snapshot.events.length - 1 ? 'current' : ''}"><span class="timeline-marker"></span><div class="timeline-content"><div class="timeline-top"><strong>${escapeHtml(statusLabel(event.type))}</strong><time>${new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>${escapeHtml(detail || 'Runtime event recorded.')}</p></div></div>`;
  }).join('');
};

const renderEvidence = (snapshot: InvestigationSnapshot): void => {
  const evidence = snapshot.state?.evidence ?? [];
  evidenceCount.textContent = String(evidence.length);
  if (!evidence.length) {
    evidenceList.innerHTML = '<div class="empty-state">Evidence will appear here.</div>';
    return;
  }
  evidenceList.innerHTML = evidence.slice().reverse().slice(0, 8).map((item) => {
    const source = typeof item.source === 'string' ? item.source : 'SYSTEM';
    const confidence = typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : '—';
    const summary = typeof item.summary === 'string' ? item.summary : 'Evidence recorded.';
    const url = typeof item.url === 'string' ? item.url : '';
    return `<article class="evidence-item"><div class="evidence-top"><span class="source-tag">${escapeHtml(source)}</span><span class="confidence">${confidence}</span></div><p>${escapeHtml(summary)}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open reference <span aria-hidden="true">↗</span></a>` : ''}</article>`;
  }).join('');
};

const renderApproval = (snapshot: InvestigationSnapshot): void => {
  const approval = snapshot.pendingApproval;
  approvalPanel.hidden = !approval;
  if (!approval) return;
  $('#approval-risk').textContent = approval.riskLevel;
  approvalReason.textContent = approval.reason;
  approvalMeta.textContent = `${approval.toolName}${approval.purpose ? ` · ${approval.purpose}` : ''}`;
};

const renderResolution = (snapshot: InvestigationSnapshot): void => {
  const result = snapshot.state?.finalResult;
  resolutionPanel.hidden = !result;
  if (!result) return;
  const success = result.outcome === 'SUCCESS';
  resolutionEyebrow.textContent = success ? 'RESOLUTION CONFIRMED' : 'INVESTIGATION ENDED';
  resolutionTitle.textContent = success ? 'The system has a verified result.' : statusLabel(result.outcome);
  resolutionSummary.textContent = result.summary;
  actionsCount.textContent = String(result.actionsExecuted);
  recoveryCount.textContent = String(result.recoveryAttempts);
};

const render = (snapshot: InvestigationSnapshot): void => {
  latestSnapshot = snapshot;
  if (!snapshot.running && activeStream) {
    activeStream.close();
    activeStream = null;
  }
  const status = snapshot.state?.status ?? 'INITIALIZING';
  const terminal = snapshot.state?.finalResult;
  const voiceState = terminal
    ? (terminal.outcome === 'SUCCESS' ? 'COMPLETED' : 'ERROR')
    : snapshot.pendingApproval ? 'AWAITING_APPROVAL'
      : (status === 'REASONING' || status === 'PLANNING') ? 'THINKING'
      : snapshot.running ? 'INVESTIGATING' : 'IDLE';
  voiceButton.dataset.runtimeState = voiceBusy ? 'SPEAKING' : voiceState;
  stateBadge.textContent = terminal ? statusLabel(terminal.outcome) : statusLabel(status);
  stateBadge.dataset.state = terminal ? terminal.outcome : status;
  connectionLabel.textContent = snapshot.running ? statusLabel(status) : terminal?.outcome ?? 'READY';
  renderTimeline(snapshot);
  renderEvidence(snapshot);
  renderApproval(snapshot);
  renderResolution(snapshot);
  if (snapshot.state?.currentHypothesis?.statement) bimoTranscript.textContent = snapshot.state.currentHypothesis.statement;
  if (terminal && voiceBusy === false) {
    voiceBusy = true;
    voiceButton.dataset.runtimeState = 'SPEAKING';
    bimoTranscript.textContent = terminal.summary;
    void voiceOutput.speak(terminal.summary).finally(() => {
      voiceBusy = false;
      voiceButton.dataset.runtimeState = terminal.outcome === 'SUCCESS' ? 'COMPLETED' : 'ERROR';
    });
  }
};

const showError = (message: string): void => {
  connectionLabel.textContent = 'ERROR';
  stateBadge.textContent = 'ERROR';
  stateBadge.dataset.state = 'ERROR';
  voiceHint.textContent = message;
};

const beginInvestigation = async (problem: string): Promise<void> => {
  const trimmed = problem.trim();
  if (!trimmed) return;
  activeStream?.close();
  resolutionPanel.hidden = true;
  approvalPanel.hidden = true;
  transcriptText.textContent = trimmed;
  problemInput.value = trimmed;
  connectionLabel.textContent = 'STARTING';
  voiceButton.classList.add('busy');
  try {
    const { investigationId } = await startInvestigation(trimmed);
    activeInvestigationId = investigationId;
    activeStream = connectInvestigation(investigationId, render, (update) => render(update.snapshot), (message) => {
      if (latestSnapshot?.running) showError(message);
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : 'BIMO could not start the investigation.');
  } finally {
    voiceButton.classList.remove('busy');
  }
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void beginInvestigation(problemInput.value);
});

voiceButton.addEventListener('click', () => {
  if (!voiceInput.supported) {
    problemInput.focus();
    return;
  }
  if (voiceButton.getAttribute('aria-pressed') === 'true') {
    voiceInput.stop();
    return;
  }
  voiceButton.setAttribute('aria-pressed', 'true');
  voiceInput.start((transcript) => {
    voiceButton.setAttribute('aria-pressed', 'false');
    void beginInvestigation(transcript);
  }, (state: VoiceInputState, message?: string) => {
    voiceButton.setAttribute('aria-pressed', state === 'LISTENING' ? 'true' : 'false');
    voiceButton.dataset.voiceState = state;
    if (message) voiceHint.textContent = message;
    else if (state === 'LISTENING') voiceHint.textContent = 'Listening…';
    else voiceHint.textContent = voiceInput.supported ? 'Browser microphone ready' : 'Use the text field on this device';
  });
});

$('#approve-button').addEventListener('click', async () => {
  if (!activeInvestigationId) return;
  try { await decideApproval(activeInvestigationId, true); } catch (error) { showError(error instanceof Error ? error.message : 'Approval could not be recorded.'); }
});

$('#deny-button').addEventListener('click', async () => {
  if (!activeInvestigationId) return;
  try { await decideApproval(activeInvestigationId, false); } catch (error) { showError(error instanceof Error ? error.message : 'Denial could not be recorded.'); }
});
