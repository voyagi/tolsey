// The faces a first screen is set in, loaded. Mona Sans (308 kB, its authors' own file) and JetBrains Mono arrive late
// on a slow connection, so the wall's landing waits for them before its second, and the launch page asks for its
// 1.45 MB pen face only after them. A face that fails or never comes holds a caller back four seconds at most.
window.tolseyFaces = () => Promise.race([
  Promise.all(['900 1em "Mona Sans"', '800 1em "JetBrains Mono"'].map((face) => document.fonts.load(face).catch(() => []))),
  new Promise((resolve) => setTimeout(resolve, 4000)),
]);
