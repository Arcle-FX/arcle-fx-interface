// ============================================================
//  NetworkLogo — network icon with Arc fallback
// ============================================================

interface Props { logo: string | null; label: string; size?: number }

/**
 * Renders a network logo image.
 * Falls back to a gradient "A" div when `logo` is null (Arc or unknown network).
 */
export default function NetworkLogo({ logo, label, size = 20 }: Props) {
  if (!logo) {
    return (
      <div
        className="arc-logo"
        style={{ width: size, height: size, fontSize: size * 0.5, flexShrink: 0 }}
      >
        A
      </div>
    );
  }
  return <img src={logo} alt={label} style={{ width: size, height: size, borderRadius: '50%' }} />;
}
