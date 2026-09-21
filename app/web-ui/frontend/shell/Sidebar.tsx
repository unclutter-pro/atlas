import { NAV, type AreaDef } from "../areas";
import { Link } from "../router";

export function Sidebar(props: { agentName: string; current: AreaDef | null }) {
  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-logo">
        {props.agentName.toUpperCase()}
      </Link>
      <nav>
        {NAV.map((group) => (
          <div key={group.group} className="nav-group">
            <div className="nav-group-label">{group.group}</div>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${item.area === props.current?.key ? " active" : ""}`}
                aria-current={item.area === props.current?.key ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
