// Shared MIRAVIKA brand styling for auth email templates.
// Email-safe: Body background stays #ffffff; brand colors live inside.

export const colors = {
  ivory: '#F8F5F1',
  gold: '#C9A86A',
  beige: '#EFE7DD',
  charcoal: '#2B2B2B',
  muted: '#6B6660',
  border: '#E5DCCF',
}

export const main = {
  backgroundColor: '#ffffff',
  fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
}

export const container = {
  backgroundColor: colors.ivory,
  border: `1px solid ${colors.border}`,
  borderRadius: '12px',
  margin: '24px auto',
  padding: '40px 36px',
  maxWidth: '520px',
}

export const brandMark = {
  color: colors.charcoal,
  fontFamily: "Georgia, 'Times New Roman', serif",
  fontSize: '26px',
  fontWeight: 'bold' as const,
  letterSpacing: '6px',
  margin: '0',
  textAlign: 'center' as const,
}

export const brandTagline = {
  color: colors.gold,
  fontSize: '10px',
  letterSpacing: '4px',
  margin: '6px 0 32px',
  textAlign: 'center' as const,
  textTransform: 'uppercase' as const,
}

export const divider = {
  borderTop: `1px solid ${colors.border}`,
  margin: '0 0 28px',
}

export const h1 = {
  color: colors.charcoal,
  fontFamily: "Georgia, 'Times New Roman', serif",
  fontSize: '22px',
  fontWeight: '600' as const,
  margin: '0 0 20px',
  textAlign: 'center' as const,
}

export const text = {
  color: colors.muted,
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '0 0 24px',
}

export const link = { color: colors.charcoal, textDecoration: 'underline' }

export const button = {
  backgroundColor: colors.charcoal,
  borderRadius: '999px',
  color: colors.ivory,
  display: 'block',
  fontSize: '13px',
  fontWeight: '600' as const,
  letterSpacing: '2px',
  margin: '0 auto',
  padding: '14px 32px',
  textAlign: 'center' as const,
  textDecoration: 'none',
  textTransform: 'uppercase' as const,
  width: 'fit-content',
}

export const codeStyle = {
  backgroundColor: colors.beige,
  border: `1px solid ${colors.border}`,
  borderRadius: '8px',
  color: colors.charcoal,
  fontFamily: 'Courier, monospace',
  fontSize: '24px',
  fontWeight: 'bold' as const,
  letterSpacing: '6px',
  margin: '0 0 30px',
  padding: '14px 0',
  textAlign: 'center' as const,
}

export const footer = {
  color: '#A39B8F',
  fontSize: '12px',
  lineHeight: '1.5',
  margin: '32px 0 0',
  textAlign: 'center' as const,
}
