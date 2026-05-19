export interface VodPrefetchPlanInput {
  currentTrack: "audio" | "video";
  currentSequence: number;
  videoBaseUrl: string | null;
  audioBaseUrl: string | null;
  videoWindow: number;
  audioWindow: number;
  includeCurrent: boolean;
}

export function buildVodPrefetchPlan(input: VodPrefetchPlanInput): string[] {
  const tasks: string[] = [];
  const currentBaseUrl = input.currentTrack === "audio" ? input.audioBaseUrl : input.videoBaseUrl;
  appendTrackUrls(tasks, currentBaseUrl, input.currentSequence, input.currentTrack === "audio" ? input.audioWindow : input.videoWindow, input.includeCurrent);

  const counterpartBaseUrl = input.currentTrack === "audio" ? input.videoBaseUrl : input.audioBaseUrl;
  appendTrackUrls(tasks, counterpartBaseUrl, input.currentSequence, input.currentTrack === "audio" ? input.videoWindow : input.audioWindow, input.includeCurrent);

  return tasks;
}

function appendTrackUrls(
  tasks: string[],
  templateUrl: string | null,
  currentSequence: number,
  window: number,
  includeCurrent: boolean,
): void {
  if (!templateUrl) {
    return;
  }
  if (includeCurrent) {
    const currentUrl = replaceUrlSequence(templateUrl, currentSequence);
    if (currentUrl) {
      pushUnique(tasks, currentUrl);
    }
  }
  for (let step = 1; step < window; step += 1) {
    const nextUrl = replaceUrlSequence(templateUrl, currentSequence + step);
    if (nextUrl) {
      pushUnique(tasks, nextUrl);
    }
  }
}

function replaceUrlSequence(templateUrl: string, sequence: number): string | null {
  try {
    const parsed = new URL(templateUrl);
    const match = parsed.pathname.match(/^(.*?)(\d+)(\.[^.\/]+)$/);
    if (!match) {
      return null;
    }
    parsed.pathname = `${match[1]}${sequence}${match[3]}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function pushUnique(tasks: string[], url: string): void {
  if (!tasks.includes(url)) {
    tasks.push(url);
  }
}
