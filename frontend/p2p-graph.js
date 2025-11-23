(function (global) {
  const noop = () => {};
  const noopGraph = {
    addOrUpdatePeer: noop,
    removePeer: noop,
    addLink: noop,
    removeLink: noop,
    hasPeer: () => false,
    reset: noop,
  };

  if (!global.d3) {
    global.P2PGraph = noopGraph;
    return;
  }

  const svg = d3.select("#p2pGraph");
  if (!svg.node()) {
    global.P2PGraph = noopGraph;
    return;
  }

  const state = {
    nodes: new Map(),
    links: new Map(),
    tooltip: document.getElementById("p2pTooltip"),
    width: +svg.attr("width"),
    height: +svg.attr("height"),
  };

  const simulation = d3
    .forceSimulation()
    .force(
      "link",
      d3
        .forceLink()
        .id((d) => d.id)
        .distance(120)
        .strength(0.5)
    )
    .force("charge", d3.forceManyBody().strength(-250))
    .force("center", d3.forceCenter(state.width / 2, state.height / 2));

  let linkEl = svg
    .append("g")
    .attr("stroke", "#555")
    .attr("stroke-width", 2)
    .selectAll("line");
  let nodeEl = svg
    .append("g")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .selectAll("circle");
  let textEl = svg.append("g").selectAll("text");

  function updateGraph() {
    const nodes = Array.from(state.nodes.values());
    const links = Array.from(state.links.values());

    linkEl = linkEl.data(links, (d) => d.key);
    linkEl.exit().remove();
    linkEl = linkEl
      .enter()
      .append("line")
      .attr("stroke", "#4e6cff")
      .merge(linkEl);

    nodeEl = nodeEl.data(nodes, (d) => d.id);
    nodeEl.exit().remove();
    nodeEl = nodeEl
      .enter()
      .append("circle")
      .attr("r", 12)
      .attr("fill", (d) => (d.isHost ? "#ff5b5b" : "#5b78ff"))
      .style("cursor", "pointer")
      .on("mouseover", handleNodeHover)
      .on("mousemove", handleNodeMove)
      .on("mouseout", handleNodeOut)
      .merge(nodeEl);

    textEl = textEl.data(nodes, (d) => d.id);
    textEl.exit().remove();
    textEl = textEl
      .enter()
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "25")
      .attr("fill", "#333")
      .attr("font-size", "11px")
      .attr("font-weight", "bold")
      .style("pointer-events", "none")
      .merge(textEl)
      .text((d) => d.displayName || d.id.substring(0, 6));

    simulation.nodes(nodes).on("tick", () => {
      linkEl
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      nodeEl.attr("cx", (d) => d.x).attr("cy", (d) => d.y);

      textEl.attr("x", (d) => d.x).attr("y", (d) => d.y);
    });

    simulation.force("link").links(links);
    simulation.alpha(0.5).restart();
  }

  function keyForLink(a, b) {
    if (!a || !b) return null;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function addOrUpdatePeer(peerId, meta = {}) {
    if (!peerId) return;
    const existing = state.nodes.get(peerId) || {id: peerId};
    existing.isHost = !!meta.isHost;
    if (meta.ip !== undefined) existing.ip = meta.ip;
    if (meta.port !== undefined) existing.port = meta.port;
    if (meta.have !== undefined) existing.have = meta.have;
    if (meta.displayName !== undefined) existing.displayName = meta.displayName;
    state.nodes.set(peerId, existing);
    updateGraph();
  }

  function removePeer(peerId) {
    if (!peerId) return;
    state.nodes.delete(peerId);
    for (const [key, link] of state.links) {
      const src =
        typeof link.source === "object" ? link.source.id : link.source;
      const dst =
        typeof link.target === "object" ? link.target.id : link.target;
      if (src === peerId || dst === peerId) {
        state.links.delete(key);
      }
    }
    updateGraph();
  }

  function addLink(a, b) {
    const key = keyForLink(a, b);
    if (!key) return;
    state.links.set(key, {key, source: a, target: b});
    updateGraph();
  }

  function removeLink(a, b) {
    const key = keyForLink(a, b);
    if (!key) return;
    state.links.delete(key);
    updateGraph();
  }

  function hasPeer(peerId) {
    return state.nodes.has(peerId);
  }

  function reset() {
    state.nodes.clear();
    state.links.clear();
    updateGraph();
    if (state.tooltip) state.tooltip.style.display = "none";
  }

  function tooltipHtml(d) {
    let html = `<b>${d.isHost ? "HOST" : "Peer"}</b><br>`;
    if (d.displayName) html += `<b>Name:</b> ${d.displayName}<br>`;
    html += `<b>ID:</b> ${d.id}<br>`;
    if (d.ip) html += `<b>IP:</b> ${d.ip}<br>`;
    if (d.port !== undefined) html += `<b>Port:</b> ${d.port}<br>`;
    if (d.have !== undefined) html += `<b>Have:</b> ${d.have}<br>`;
    return html;
  }

  function handleNodeHover(event, d) {
    if (!state.tooltip) return;
    state.tooltip.innerHTML = tooltipHtml(d);
    state.tooltip.style.display = "block";
  }

  function handleNodeMove(event) {
    if (!state.tooltip) return;
    state.tooltip.style.left = event.pageX + 12 + "px";
    state.tooltip.style.top = event.pageY + 12 + "px";
  }

  function handleNodeOut() {
    if (!state.tooltip) return;
    state.tooltip.style.display = "none";
  }

  global.P2PGraph = {
    addOrUpdatePeer,
    removePeer,
    addLink,
    removeLink,
    hasPeer,
    reset,
  };
})(window);
