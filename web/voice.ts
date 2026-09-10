export type VoiceInputState = 'IDLE' | 'LISTENING' | 'ERROR';

export interface VoiceInput {
  readonly supported: boolean;
  start(onTranscript: (transcript: string) => void, onState: (state: VoiceInputState, message?: string) => void): void;
  stop(): void;
}

export interface VoiceOutput {
  readonly supported: boolean;
  speak(text: string): Promise<void>;
  stop(): void;
}

interface SpeechRecognitionEventLike extends Event {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

interface SpeechWindow extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

export class BrowserSpeechInput implements VoiceInput {
  private readonly recognition: SpeechRecognitionLike | null;
  private onState: ((state: VoiceInputState, message?: string) => void) | null = null;

  constructor() {
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    this.recognition = Recognition ? new Recognition() : null;
    if (this.recognition) {
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-US';
    }
  }

  get supported(): boolean { return this.recognition !== null; }

  start(onTranscript: (transcript: string) => void, onState: (state: VoiceInputState, message?: string) => void): void {
    if (!this.recognition) {
      onState('ERROR', 'Speech recognition is not available in this browser.');
      return;
    }
    this.onState = onState;
    this.recognition.onstart = () => onState('LISTENING');
    this.recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) onTranscript(transcript);
    };
    this.recognition.onerror = (event) => onState('ERROR', `Microphone error: ${event.error ?? 'permission denied'}.`);
    this.recognition.onend = () => {
      this.onState?.('IDLE');
      this.onState = null;
    };
    try {
      this.recognition.start();
    } catch (error) {
      onState('ERROR', error instanceof Error ? error.message : 'Speech recognition could not start.');
    }
  }

  stop(): void {
    this.recognition?.stop();
  }
}

export class BrowserSpeechOutput implements VoiceOutput {
  get supported(): boolean { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }

  speak(text: string): Promise<void> {
    if (!this.supported) return Promise.resolve();
    this.stop();
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    if (this.supported) window.speechSynthesis.cancel();
  }
}
