import { pipeline } from '@huggingface/transformers';
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny');
const sr = 16000, n = sr * 2, a = new Float32Array(n);
for (let i = 0; i < n; i++) a[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / sr);
const out = await asr(a, { return_timestamps: true, chunk_length_s: 30 });
console.log('ok in', Date.now() - t0, 'ms', JSON.stringify(out).slice(0, 200));
