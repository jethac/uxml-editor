import './app.css';

export function App() {
  return (
    <div className="workbench" role="application" aria-label="UXML Editor">
      <header className="command-bar" role="toolbar" aria-label="Command bar">
        <strong>UXML Editor</strong>
        <span>No project open</span>
      </header>

      <main className="workspace">
        <section className="pane hierarchy" aria-labelledby="hierarchy-heading">
          <h2 id="hierarchy-heading">Hierarchy</h2>
          <div className="pane-body" />
        </section>

        <section className="pane canvas" aria-labelledby="canvas-heading">
          <h2 id="canvas-heading">Canvas</h2>
          <div className="pane-body" />
        </section>

        <section className="pane inspector" aria-labelledby="inspector-heading">
          <h2 id="inspector-heading">Inspector</h2>
          <div className="pane-body" />
        </section>

        <section className="pane diagnostics" aria-labelledby="diagnostics-heading">
          <h2 id="diagnostics-heading">Diagnostics</h2>
          <div className="pane-body" />
        </section>
      </main>
    </div>
  );
}
