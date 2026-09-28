export function safeFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'terrax';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** Strips Markdown syntax so report text reads cleanly in a PDF. */
function markdownToPlain(md: string): string[] {
  return md.split('\n').map(line =>
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
      .replace(/^\s*[-*]\s+/, '• ')
      .replace(/^\|?\s*-{3,}.*$/, '')
      .replace(/\|/g, '  '),
  );
}

/** Writes a multi-page, text-based (selectable) A4 PDF of a Markdown report. */
export async function downloadReportPdf(title: string, subtitle: string, markdown: string, filename: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 18;
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensureSpace = (h: number) => {
    if (y + h > pageH - margin) {
      pdf.addPage();
      y = margin;
    }
  };

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text(title, margin, y);
  y += 7;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90);
  pdf.text(subtitle, margin, y);
  pdf.setTextColor(20);
  y += 8;

  const source = markdown.split('\n');
  markdownToPlain(markdown).forEach((line, i) => {
    const isHeading = /^#{1,6}\s/.test(source[i]);
    pdf.setFont('helvetica', isHeading ? 'bold' : 'normal');
    pdf.setFontSize(isHeading ? 12 : 10);
    if (!line.trim()) {
      y += 2.5;
      return;
    }
    const wrapped = pdf.splitTextToSize(line, maxW) as string[];
    const lineH = isHeading ? 6 : 4.8;
    if (isHeading) y += 2;
    for (const w of wrapped) {
      ensureSpace(lineH);
      pdf.text(w, margin, y);
      y += lineH;
    }
  });

  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setFontSize(8);
    pdf.setTextColor(120);
    pdf.text(`TerraX · page ${p} of ${pages}`, margin, pageH - 8);
  }
  pdf.save(filename);
}
