import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRuntime } from '../src/runtime.ts';
import { validSemanticPlan } from '../src/semantic-math.ts';
import { quadratic } from '../tests/semantic-fixtures.ts';

const execute = promisify(execFile);
const plan = structuredClone(quadratic);
Object.assign(plan.beats[3], { cueFrame: 1235, narrationScope: 'process',
  narration: 'Watch the time step shrink as the moving point approaches the first point.' });
assert(validSemanticPlan(plan));
const scratch = await mkdtemp(join(tmpdir(), 'raea semantic qualification '));
const output = join(scratch, 'synthetic.mp4');
const runtime = createRuntime(scratch);
const signal = AbortSignal.timeout(13 * 60_000);
const options = { narration: true, voice: 'alba', maxSeconds: 90, progress: console.log };
const render = (consent) => runtime.render(plan, output, 'dark', consent, signal, options);
const ff = (tool, args, extra = {}) => execute(tool, args, { timeout: 120_000, signal, ...extra });

try {
  assert(runtime.asset && !runtime.runtimeInstalled() && !runtime.pocketInstalled());
  await assert.rejects(render({ runtime: false, speech: true }), /runtime download needs your approval/i);
  await assert.rejects(render({ runtime: true, speech: false }), /narration model download needs your approval/i);
  assert(runtime.runtimeInstalled() && !runtime.pocketInstalled());
  await render({ runtime: false, speech: true });
  assert(runtime.pocketInstalled());
  const { stdout } = await ff('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_read_frames,duration', '-of', 'json', output]);
  const { streams } = JSON.parse(stdout);
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.deepEqual([video.width, video.height, Number(video.nb_read_frames)], [1920, 1080, 2700]);
  assert.equal(Number(video.duration), 90);
  assert.equal(audio?.codec_name, process.platform === 'darwin' ? 'aac' : 'opus');
  assert(Math.abs(Number(audio.duration) - 90) < 0.2);
  await ff('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);

  const peak = async (start, duration) => {
    const { stdout: pcm } = await ff('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-ss', String(start), '-i', output,
      '-map', '0:a:0', '-t', String(duration), '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer' });
    assert(pcm.length >= Math.floor(duration * 15000) * 4);
    let maximum = 0;
    for (let i = 0; i + 4 <= pcm.length; i += 4) maximum = Math.max(maximum, Math.abs(pcm.readFloatLE(i)));
    return maximum;
  };
  const beforeCue = await peak(40.75, 0.3);
  const moving = await peak(41.3, 2);
  const settled = await peak(59.7, 2);
  assert(beforeCue < 0.015 && moving > 0.03 && settled > 0.03);
  console.log(JSON.stringify({ video, audio, beforeCue, moving, settled, fullDecode: true }));
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
