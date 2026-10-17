// Draws the Networkversity Certificate of Completion on a <canvas>, following
// the FHG Concept template (842 x 561 design units, rendered at 2.5x).
window.Certificate = (() => {
  const W = 842;
  const H = 561;
  const SCALE = 2.5;
  const BLUE = '#4a86d8';
  const FRAME = '#1b8bc9';
  const GREY = '#7a8494';
  const INK = '#1f2a37';

  let logoPromise;
  function loadLogo() {
    logoPromise ||= new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = '/img/logo.png';
    });
    return logoPromise;
  }

  async function loadFonts() {
    if (!document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load('900 30px Lato'),
        document.fonts.load('700 14px Lato'),
        document.fonts.load('400 14px Lato'),
        document.fonts.load('700 24px "Dancing Script"'),
      ]);
    } catch {
      // fall back to system fonts
    }
  }

  const font = (weight, size, family = 'Lato') =>
    `${weight} ${size}px ${family === 'Lato' ? 'Lato, "Segoe UI", Roboto, Arial, sans-serif' : `"${family}", "Brush Script MT", cursive`}`;

  // Draws a line of mixed-style text centred on x; shrinks it to fit maxWidth.
  function richLine(ctx, parts, x, y, size, maxWidth) {
    let s = size;
    const measure = () =>
      parts.reduce((w, p) => {
        ctx.font = font(p.weight || 400, s);
        return w + ctx.measureText(p.text).width;
      }, 0);
    while (measure() > maxWidth && s > 7) s -= 0.5;
    let cx = x - measure() / 2;
    for (const p of parts) {
      ctx.font = font(p.weight || 400, s);
      ctx.fillStyle = p.color || GREY;
      ctx.fillText(p.text, cx, y);
      cx += ctx.measureText(p.text).width;
    }
  }

  function fitText(ctx, text, maxWidth, weight, size, family) {
    let s = size;
    ctx.font = font(weight, s, family);
    while (ctx.measureText(text).width > maxWidth && s > 8) {
      s -= 0.5;
      ctx.font = font(weight, s, family);
    }
  }

  async function draw(canvas, d) {
    await Promise.all([loadFonts(), loadLogo()]);
    const logo = await loadLogo();
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    // outer thin frame
    ctx.strokeStyle = '#1f6fa8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(22, 22, W - 44, H - 44);

    // inner panel with the light "x" pattern
    const ix = 46, iy = 46, iw = W - 92, ih = H - 92;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.fillStyle = '#fbfefe';
    ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = 'rgba(120, 214, 214, 0.35)';
    ctx.lineWidth = 1;
    const step = 24;
    for (let row = 0, y = iy + 12; y < iy + ih; row++, y += step) {
      for (let x = ix + 12 + (row % 2 ? step / 2 : 0); x < ix + iw; x += step) {
        ctx.beginPath();
        ctx.moveTo(x - 2.5, y - 2.5);
        ctx.lineTo(x + 2.5, y + 2.5);
        ctx.moveTo(x + 2.5, y - 2.5);
        ctx.lineTo(x - 2.5, y + 2.5);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.strokeStyle = FRAME;
    ctx.lineWidth = 3;
    ctx.strokeRect(ix, iy, iw, ih);

    // logo
    if (logo) {
      const lw = 72;
      const lh = (logo.height / logo.width) * lw;
      ctx.drawImage(logo, W / 2 - lw / 2, 72, lw, lh);
    }

    ctx.textAlign = 'left';
    // title
    ctx.fillStyle = BLUE;
    ctx.font = font(900, 30);
    const title = 'Certificate of Completion';
    ctx.fillText(title, W / 2 - ctx.measureText(title).width / 2, 188);

    // certification sentence
    const dateText = d.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeText = d.date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    richLine(
      ctx,
      [
        { text: 'We certify that ' },
        { text: d.name, weight: 900, color: INK },
        { text: ' has completed the ' },
        { text: 'Networkversity', weight: 900, color: BLUE },
        { text: ' course finalized on ' },
        { text: `${dateText}, ${timeText}`, weight: 700, color: INK },
      ],
      W / 2,
      222,
      12.5,
      iw - 60,
    );

    // score
    ctx.textAlign = 'center';
    ctx.fillStyle = GREY;
    ctx.font = font(700, 11);
    ctx.fillText('FINAL EXAM SCORE', W / 2, 270);
    ctx.fillStyle = INK;
    ctx.font = font(900, 46);
    const scoreText = `${d.score} / ${d.total}`;
    ctx.fillText(scoreText, W / 2, 318);
    ctx.fillStyle = GREY;
    ctx.font = font(700, 14);
    ctx.fillText('POINTS', W / 2, 340);

    // grade pill
    ctx.font = font(900, 15);
    const gradeText = `Grade: ${d.band}`;
    const gw = ctx.measureText(gradeText).width + 36;
    ctx.fillStyle = '#e7f7ea';
    roundRect(ctx, W / 2 - gw / 2, 356, gw, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#1e6b2a';
    ctx.fillText(gradeText, W / 2, 375);

    // signature lines
    const lineY = 481;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(65, lineY);
    ctx.lineTo(277, lineY);
    ctx.moveTo(565, lineY);
    ctx.lineTo(778, lineY);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    fitText(ctx, d.name, 210, 700, 15);
    ctx.fillText(d.name, 66, lineY - 10);
    ctx.font = font(700, 8.5);
    ctx.fillText('Student Name', 66, lineY + 12);

    ctx.fillStyle = '#2b3a55';
    ctx.font = font(700, 22, 'Dancing Script');
    ctx.fillText('Omotola', 566, lineY - 10);
    ctx.fillStyle = INK;
    ctx.font = font(700, 8.5);
    ctx.fillText('FHG Concept', 566, lineY + 12);

    if (d.certificateId) {
      ctx.textAlign = 'center';
      ctx.fillStyle = GREY;
      ctx.font = font(400, 8);
      ctx.fillText(`Certificate ID: ${d.certificateId}`, W / 2, 506);
    }
    return canvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function downloadPng(d, filename) {
    const canvas = await draw(document.createElement('canvas'), d);
    canvas.toBlob((blob) => saveBlob(blob, filename), 'image/png');
  }

  async function downloadPdf(d, filename) {
    if (!window.jspdf) {
      alert('PDF download is unavailable right now, downloading the certificate as an image instead.');
      return downloadPng(d, filename.replace(/\.pdf$/, '.png'));
    }
    const canvas = await draw(document.createElement('canvas'), d);
    // Page size keeps the template's 3:2 proportions (300 x 200 mm).
    const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: [300, 200] });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 300, 200);
    pdf.setProperties({ title: `Networkversity Certificate - ${d.name}`, author: 'FHG Concept' });
    pdf.save(filename);
  }

  return { draw, downloadPng, downloadPdf };
})();
