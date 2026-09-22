export type CapturedRequest = Pick<Request, 'method' | 'url'>;
export type CapturedResponse = Pick<XMLHttpRequest, 'status' | 'responseText'>;
export type ResponseListener = (request: CapturedRequest, response: CapturedResponse) => void;
export type MenuAction = 'toggle-panel' | 'open-settings' | 'about';
