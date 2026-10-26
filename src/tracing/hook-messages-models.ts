export interface HookOutput {
  name: string;
  text: string;
  id: string;
}

export interface HookMessage {
  role: "system";
  name: string;
  id: string;
  content: string;
}
