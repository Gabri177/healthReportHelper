// Normalises a dropped file before upload: PDFs go as they are; photos are decoded,
// shrunk to a size the model reads well, and re-encoded as JPEG (this also converts HEIC where the browser can decode it).

const MAX_EDGE = 2400;
const DIRECT = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type Prepared = { blob: Blob; name: string; preview: string | null } | { error: string };

export function isAccepted(f: File) {
  return f.type.startsWith('image/') || f.type === 'application/pdf' || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(f.name);
}

export async function prepare(file: File): Promise<Prepared> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 30 * 1024 * 1024) return { error: 'PDF 不能超过 30 MB' };
    return { blob: file, name: file.name, preview: null };
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { error: /\.(heic|heif)$/i.test(file.name) ? '浏览器读不了这张 HEIC 照片，请先导出为 JPG' : '无法读取这张图片' };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && DIRECT.has(file.type) && file.size < 3.5 * 1024 * 1024) {
    bmp.close();
    return { blob: file, name: file.name, preview: URL.createObjectURL(file) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return { error: '无法处理这张图片' };
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return { blob, name, preview: URL.createObjectURL(blob) };
}

/** Fake report pages for MOCK_AI mode, so the flow can be tried without real files. */
export async function sampleFiles(): Promise<File[]> {
  const out: File[] = [];
  const titles = ['2026 年度体检 · 第 1 页', '2026 年度体检 · 第 2 页', '2025 年度体检'];
  for (const [i, title] of titles.entries()) {
    const c = document.createElement('canvas');
    c.width = 620;
    c.height = 860;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#123';
    g.font = 'bold 30px sans-serif';
    g.fillText(title, 40, 70);
    g.fillStyle = '#9ab';
    for (let y = 120; y < 800; y += 34) g.fillRect(40, y, 160 + ((y * 7) % 340), 10);
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', 0.85));
    out.push(new File([blob], `示例报告_${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  return out;
}
