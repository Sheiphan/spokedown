declare module "speech-rule-engine" {
  const sre: {
    setupEngine(options: Record<string, unknown>): Promise<void>;
    engineReady(): Promise<void>;
    toSpeech(mathml: string): string;
  };
  export default sre;
}
