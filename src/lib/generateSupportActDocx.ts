import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  ShadingType,
} from 'docx';
import { format, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';
import { EXECUTOR_REQUISITES } from './companyRequisites';
import { sumActHours } from './supportActTypes';
import type { SupportAct } from './supportActTypes';

const TEAL = '0D9488';
const SLATE = '0F172A';
const MUTED = '64748B';
const LIGHT = 'F0FDFA';
const BORDER = 'CCFBF1';

export interface SupportActDocxInput {
  contractNumber: string;
  contractStartDate: string;
  counterpartyName: string;
  counterpartyDetails: string;
  act: SupportAct;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  try {
    return format(parseISO(iso), 'dd.MM.yyyy');
  } catch {
    return iso;
  }
}

function fmtDateQuoted(iso: string): string {
  if (!iso) return '«__» ________ ____ г.';
  try {
    return format(parseISO(iso), '«d» MMMM yyyy г.', { locale: ru });
  } catch {
    return iso;
  }
}

function money(n: number): string {
  return `${(n || 0).toLocaleString('ru-RU')} руб.`;
}

function cell(
  text: string,
  opts: {
    bold?: boolean;
    fill?: string;
    width?: number;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    color?: string;
  } = {}
) {
  return new TableCell({
    width: { size: opts.width ?? 2000, type: WidthType.DXA },
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    },
    children: [
      new Paragraph({
        alignment: opts.align ?? AlignmentType.LEFT,
        children: [
          new TextRun({
            text,
            bold: opts.bold,
            size: 18,
            font: 'Calibri',
            color: opts.color ?? SLATE,
          }),
        ],
      }),
    ],
  });
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: 280, after: 160 },
    children: [
      new TextRun({
        text,
        bold: true,
        size: level === HeadingLevel.HEADING_1 ? 28 : 22,
        font: 'Calibri',
        color: SLATE,
      }),
    ],
  });
}

function body(text: string, opts: { bold?: boolean; color?: string; center?: boolean } = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: 80 },
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        size: 20,
        font: 'Calibri',
        color: opts.color ?? SLATE,
      }),
    ],
  });
}

function muted(text: string) {
  return body(text, { color: MUTED });
}

function spacer(after = 120) {
  return new Paragraph({ spacing: { after }, children: [] });
}

export async function generateSupportActDocxBlob(input: SupportActDocxInput): Promise<Blob> {
  const { act } = input;
  const { packageHours, overlimitHours } = sumActHours(act);
  const ex = EXECUTOR_REQUISITES;
  const periodText =
    act.periodLabel ||
    `${fmtDate(act.periodFrom)} — ${fmtDate(act.periodTo)}`;

  const hourHeader = new TableRow({
    children: [
      cell('№', { bold: true, fill: TEAL, color: 'FFFFFF', width: 600, align: AlignmentType.CENTER }),
      cell('Дата', { bold: true, fill: TEAL, color: 'FFFFFF', width: 1600, align: AlignmentType.CENTER }),
      cell('Задача', { bold: true, fill: TEAL, color: 'FFFFFF', width: 4200 }),
      cell('Часы', { bold: true, fill: TEAL, color: 'FFFFFF', width: 1000, align: AlignmentType.CENTER }),
      cell('Пакет / сверхлимит', {
        bold: true,
        fill: TEAL,
        color: 'FFFFFF',
        width: 2000,
        align: AlignmentType.CENTER,
      }),
    ],
  });

  const hourRows =
    act.hourRows.length > 0
      ? act.hourRows.map(
          (row, i) =>
            new TableRow({
              children: [
                cell(String(i + 1), { width: 600, align: AlignmentType.CENTER, fill: i % 2 ? LIGHT : 'FFFFFF' }),
                cell(fmtDate(row.date), {
                  width: 1600,
                  align: AlignmentType.CENTER,
                  fill: i % 2 ? LIGHT : 'FFFFFF',
                }),
                cell(row.task || '—', { width: 4200, fill: i % 2 ? LIGHT : 'FFFFFF' }),
                cell(String(row.hours), {
                  width: 1000,
                  align: AlignmentType.CENTER,
                  fill: i % 2 ? LIGHT : 'FFFFFF',
                }),
                cell(row.packageType === 'overlimit' ? 'Сверхлимит' : 'Пакет', {
                  width: 2000,
                  align: AlignmentType.CENTER,
                  fill: i % 2 ? LIGHT : 'FFFFFF',
                }),
              ],
            })
        )
      : [
          new TableRow({
            children: [
              cell('—', { width: 600, align: AlignmentType.CENTER }),
              cell('—', { width: 1600, align: AlignmentType.CENTER }),
              cell('Работы не указаны', { width: 4200 }),
              cell('0', { width: 1000, align: AlignmentType.CENTER }),
              cell('—', { width: 2000, align: AlignmentType.CENTER }),
            ],
          }),
        ];

  const hoursTable = new Table({
    width: { size: 9400, type: WidthType.DXA },
    rows: [hourHeader, ...hourRows],
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 40 },
            children: [
              new TextRun({
                text: ex.brandName.toUpperCase(),
                bold: true,
                size: 32,
                font: 'Calibri',
                color: TEAL,
              }),
            ],
          }),
          muted(ex.brandUrl),
          spacer(200),
          new Paragraph({
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 12, color: TEAL, space: 8 },
            },
            spacing: { after: 240 },
            children: [],
          }),

          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [
              new TextRun({
                text: `Акт № ${act.actNumber || '—'}`,
                bold: true,
                size: 36,
                font: 'Calibri',
                color: SLATE,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: `О выполненной технической поддержке в период с ${fmtDate(act.periodFrom)} по ${fmtDate(act.periodTo)}`,
                size: 22,
                font: 'Calibri',
                color: MUTED,
              }),
            ],
          }),

          body(
            `к Договору № ${input.contractNumber || '—'} от ${fmtDateQuoted(input.contractStartDate)}`,
            { bold: true }
          ),
          muted(`Период: ${periodText}`),
          spacer(160),

          heading('Стороны', HeadingLevel.HEADING_2),
          body('Исполнитель', { bold: true, color: TEAL }),
          body(ex.organizationName),
          muted(`Юр. адрес: ${ex.legalAddress}`),
          muted(`ИНН ${ex.inn} · ОГРНИП ${ex.ogrnip}`),
          muted(`р/с ${ex.bankAccount} · ${ex.bankName}`),
          muted(`БИК ${ex.bankBik} · к/с ${ex.bankCorrAccount}`),
          spacer(80),
          body('Заказчик', { bold: true, color: TEAL }),
          body(input.counterpartyName || '—'),
          ...(input.counterpartyDetails
            ? input.counterpartyDetails
                .split('\n')
                .filter(Boolean)
                .map(line => muted(line))
            : [muted('Реквизиты не указаны')]),
          spacer(200),

          heading('Приложение № 1. Отчёт по часам', HeadingLevel.HEADING_2),
          muted(`к Договору № ${input.contractNumber || '—'} · Период: ${periodText}`),
          spacer(80),
          hoursTable,
          spacer(120),
          body(
            `Итого в пакете (лимит ${act.hoursLimit}): ${packageHours}   ·   Сверхлимит: ${overlimitHours}`,
            { bold: true }
          ),
          spacer(200),

          heading('Приложение № 2. Акт оказанных услуг по поддержке', HeadingLevel.HEADING_2),
          muted(
            `к Договору № ${input.contractNumber || '—'} · Акт № ${act.actNumber || '—'} · ${fmtDateQuoted(act.periodTo || act.periodFrom || new Date().toISOString().slice(0, 10))}`
          ),
          spacer(80),
          body(
            `Поддержка за ${periodText}: пакет ${act.hoursLimit} ч, сверхлимит ${overlimitHours} ч × ${money(act.overtimeRate).replace(' руб.', '')} руб.; к оплате ${money(act.supportAmount)}. Права на результаты переданы.`
          ),
          spacer(80),
          muted('Претензий нет / есть (письменно в 5 раб. дн.): __________________'),
          spacer(280),

          heading('Подписи сторон', HeadingLevel.HEADING_2),
          new Table({
            width: { size: 9400, type: WidthType.DXA },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: 4700, type: WidthType.DXA },
                    borders: {
                      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                    },
                    children: [
                      body('Исполнитель', { bold: true, color: TEAL }),
                      muted(ex.organizationName),
                      spacer(200),
                      body('_______________ / ________________'),
                    ],
                  }),
                  new TableCell({
                    width: { size: 4700, type: WidthType.DXA },
                    borders: {
                      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
                    },
                    children: [
                      body('Заказчик', { bold: true, color: TEAL }),
                      muted(input.counterpartyName || '—'),
                      spacer(200),
                      body('_______________ / ________________'),
                    ],
                  }),
                ],
              }),
            ],
          }),
          spacer(200),
          muted(`${ex.brandName} · ${ex.brandUrl}`),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

export async function downloadSupportActDocx(input: SupportActDocxInput, fileName?: string) {
  const blob = await generateSupportActDocxBlob(input);
  const name =
    fileName ||
    `Akt_${input.act.actNumber || 'support'}_${input.act.periodFrom || 'period'}.docx`.replace(
      /[^\w\-а-яА-ЯёЁ.]+/gi,
      '_'
    );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
