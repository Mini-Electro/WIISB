using System.Collections.ObjectModel;
using WIISBROWSING.App.Models;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Tabs;

namespace WIISBROWSING.App.Services;

public sealed record ClosedTab(string Url, string Title, string WorkspaceId, string? ClusterId, bool Pinned, string Marker);

/// <summary>
/// The state behind tabs, clusters and workspaces for one window. It knows nothing about the screen or the web engine,
/// so the same tabs can be shown as vertical tabs, horizontal tabs or a hidden strip without reloading anything.
/// </summary>
public sealed class TabManager
{
    private readonly List<ClosedTab> _closed = new();
    private readonly bool _isPrivate;

    public ObservableCollection<Workspace> Workspaces { get; } = new();
    public ObservableCollection<TabCluster> Clusters { get; } = new();
    /// <summary>Every tab of the window, in order, across all workspaces.</summary>
    public ObservableCollection<BrowserTab> AllTabs { get; } = new();

    /// <summary>Pinned tabs of the active workspace.</summary>
    public ObservableCollection<BrowserTab> Pinned { get; } = new();
    /// <summary>The vertical list: cluster headers (<see cref="TabCluster"/>) and tabs (<see cref="BrowserTab"/>).</summary>
    public ObservableCollection<object> Rows { get; } = new();
    /// <summary>Flat list for the horizontal strip.</summary>
    public ObservableCollection<BrowserTab> Strip { get; } = new();

    public Workspace ActiveWorkspace { get; private set; } = null!;
    public BrowserTab? ActiveTab { get; private set; }

    public event Action<BrowserTab?>? ActiveTabChanged;
    public event Action<BrowserTab>? TabAdded;
    public event Action<BrowserTab>? TabRemoved;
    public event Action? LayoutChanged;
    /// <summary>Anything worth saving changed (debounced by the window).</summary>
    public event Action? Changed;
    public event Action? LastTabClosed;

    public TabManager(bool isPrivate) => _isPrivate = isPrivate;

    public IEnumerable<BrowserTab> TabsOf(string workspaceId) => AllTabs.Where(t => t.WorkspaceId == workspaceId);
    public BrowserTab? Find(string id) => AllTabs.FirstOrDefault(t => t.Id == id);
    public IReadOnlyList<ClosedTab> RecentlyClosed => _closed;

    // ---- start-up --------------------------------------------------------------------------------------------------

    public void InitDefaults()
    {
        foreach (var w in SessionStore.DefaultWorkspaces()) Workspaces.Add(ToModel(w));
        ActiveWorkspace = Workspaces[0];
        ActiveWorkspace.IsActive = true;
    }

    private static Workspace ToModel(WorkspaceRecord w) => new() { Id = w.Id, Name = w.Name, Icon = w.Icon, Color = w.Color, Hidden = w.Hidden };

    public void Restore(SessionSnapshot s)
    {
        Workspaces.Clear(); Clusters.Clear(); AllTabs.Clear();
        foreach (var w in s.Workspaces.OrderBy(w => w.Position)) Workspaces.Add(ToModel(w));
        if (Workspaces.Count == 0) { InitDefaults(); return; }
        foreach (var c in s.Clusters.OrderBy(c => c.Position))
            Clusters.Add(new TabCluster { Id = c.Id, WorkspaceId = c.WorkspaceId, Name = c.Name, Color = c.Color, Emoji = c.Emoji, Collapsed = c.Collapsed });
        foreach (var t in s.Tabs.OrderBy(t => t.Position))
        {
            var tab = new BrowserTab(t.Id)
            {
                Url = t.Url, Title = t.Title, IsPinned = t.Pinned, Marker = t.Marker, IsMuted = t.Muted, SleepExempt = t.SleepExempt,
                WorkspaceId = Workspaces.Any(w => w.Id == t.WorkspaceId) ? t.WorkspaceId : Workspaces[0].Id,
                ClusterId = t.ClusterId, Lifecycle = TabLifecycle.Sleeping,
                LastActive = DateTimeOffset.FromUnixTimeMilliseconds(t.LastActive == 0 ? HistoryStore.NowMs() : t.LastActive).UtcDateTime,
            };
            AllTabs.Add(tab);
        }
        foreach (var c in Clusters.ToList())
            if (!AllTabs.Any(t => t.ClusterId == c.Id)) Clusters.Remove(c);
        var ws = Workspaces.FirstOrDefault(w => w.Id == s.ActiveWorkspaceId) ?? Workspaces[0];
        ActiveWorkspace = ws;
        foreach (var w in Workspaces) w.IsActive = w == ws;
        RebuildRows();
        var active = Find(s.ActiveTabId ?? "") is { } a && a.WorkspaceId == ws.Id ? a : TabsOf(ws.Id).FirstOrDefault();
        foreach (var t in AllTabs) TabAdded?.Invoke(t);
        if (active is not null) Activate(active); else ActiveTab = null;
    }

    public SessionSnapshot Snapshot()
    {
        var wsRecords = Workspaces.Select((w, i) => new WorkspaceRecord(w.Id, w.Name, w.Icon, w.Color, i, w.Hidden)).ToList();
        var clusters = Clusters.Where(c => AllTabs.Any(t => t.ClusterId == c.Id)).Select((c, i) => new ClusterRecord(c.Id, c.WorkspaceId, c.Name, c.Color, c.Emoji, c.Collapsed, i)).ToList();
        var tabs = AllTabs
            .Where(t => !UrlIsTransient(t.Url))
            .Select((t, i) => new TabRecord(t.Id, t.WorkspaceId, t.ClusterId, t.Url, t.Title, "", t.IsPinned, t.Marker, t.IsMuted, t.SleepExempt, i,
                new DateTimeOffset(t.LastActive, TimeSpan.Zero).ToUnixTimeMilliseconds()))
            .ToList();
        return new SessionSnapshot(wsRecords, clusters, tabs, ActiveWorkspace.Id, ActiveTab?.Id);
    }

    private static bool UrlIsTransient(string url) => url.StartsWith("view-source:", StringComparison.OrdinalIgnoreCase);

    // ---- tabs --------------------------------------------------------------------------------------------------------

    public BrowserTab NewTab(string url = "wiisb://newtab", BrowserTab? opener = null, bool activate = true, string? workspaceId = null)
    {
        var tab = new BrowserTab
        {
            Url = url, WorkspaceId = workspaceId ?? ActiveWorkspace.Id, OpenerId = opener?.Id, IsPrivate = _isPrivate,
            Lifecycle = TabLifecycle.Background,
        };
        if (opener is not null && AllTabs.Contains(opener) && opener.WorkspaceId == tab.WorkspaceId && !opener.IsPinned)
        {
            tab.ClusterId = opener.ClusterId;
            // Right after the opener — and after any tabs that opener already opened — like every modern browser.
            int idx = AllTabs.IndexOf(opener) + 1;
            while (idx < AllTabs.Count && AllTabs[idx].OpenerId == opener.Id && AllTabs[idx].WorkspaceId == tab.WorkspaceId) idx++;
            AllTabs.Insert(idx, tab);
        }
        else AllTabs.Add(tab);
        TabAdded?.Invoke(tab);
        RebuildRows();
        if (activate) Activate(tab);
        Changed?.Invoke();
        return tab;
    }

    public void Activate(BrowserTab tab)
    {
        if (!AllTabs.Contains(tab)) return;
        if (tab.WorkspaceId != ActiveWorkspace.Id) SwitchWorkspaceCore(Workspaces.First(w => w.Id == tab.WorkspaceId));
        if (tab.ClusterId is { } cid && Clusters.FirstOrDefault(c => c.Id == cid) is { Collapsed: true } cl) { cl.Collapsed = false; RebuildRows(); }

        var previous = ActiveTab;
        if (previous == tab) { ActiveTabChanged?.Invoke(tab); return; }
        if (previous is not null) { previous.IsSelected = false; previous.LastActive = DateTime.UtcNow; }
        ActiveTab = tab;
        tab.IsSelected = true;
        tab.LastActive = DateTime.UtcNow;
        ActiveWorkspace.ActiveTabId = tab.Id;
        UpdateRecentRanks(previous);
        ActiveTabChanged?.Invoke(tab);
        Changed?.Invoke();
    }

    private void UpdateRecentRanks(BrowserTab? previous)
    {
        foreach (var t in AllTabs) t.RecentRank = 0;
        var recent = AllTabs.Where(t => t.WorkspaceId == ActiveWorkspace.Id && t != ActiveTab).OrderByDescending(t => t.LastActive).Take(2).ToList();
        if (previous is not null && recent.Contains(previous)) { recent.Remove(previous); recent.Insert(0, previous); }
        for (int i = 0; i < recent.Count && i < 2; i++) recent[i].RecentRank = i + 1;
    }

    public void Close(BrowserTab tab, bool remember = true)
    {
        int index = AllTabs.IndexOf(tab);
        if (index < 0) return;
        if (remember && !_isPrivate) Remember(tab);

        bool wasActive = tab == ActiveTab;
        var sameWs = AllTabs.Where(t => t.WorkspaceId == tab.WorkspaceId).ToList();
        int posInWs = sameWs.IndexOf(tab);
        AllTabs.RemoveAt(index);
        PruneClusters();
        TabRemoved?.Invoke(tab);

        // The last tab of the window is gone (whichever tab was showing): the window closes itself.
        if (AllTabs.Count == 0)
        {
            ActiveTab = null;
            RebuildRows();
            LastTabClosed?.Invoke();
            return;
        }

        if (wasActive)
        {
            ActiveTab = null;
            var next =
                (tab.OpenerId is not null ? Find(tab.OpenerId) : null) is { } o && o.WorkspaceId == tab.WorkspaceId ? o :
                sameWs.Skip(posInWs + 1).FirstOrDefault(t => AllTabs.Contains(t)) ??
                sameWs.Take(posInWs).LastOrDefault(t => AllTabs.Contains(t));
            if (next is not null) Activate(next);
            else
            {
                // The workspace is empty: keep it usable with a fresh tab instead of leaving a blank screen.
                NewTab();
            }
        }
        RebuildRows();
        Changed?.Invoke();
    }

    private void Remember(BrowserTab tab)
    {
        if (string.IsNullOrEmpty(tab.Url) || tab.Url == "wiisb://newtab") return;
        _closed.Add(new ClosedTab(tab.Url, tab.Title, tab.WorkspaceId, tab.ClusterId, tab.IsPinned, tab.Marker));
        if (_closed.Count > 30) _closed.RemoveAt(0);
    }

    public BrowserTab? Reopen()
    {
        if (_closed.Count == 0) return null;
        var c = _closed[^1];
        _closed.RemoveAt(_closed.Count - 1);
        var ws = Workspaces.Any(w => w.Id == c.WorkspaceId) ? c.WorkspaceId : ActiveWorkspace.Id;
        var tab = NewTab(c.Url, null, true, ws);
        tab.Title = c.Title; tab.IsPinned = c.Pinned; tab.Marker = c.Marker;
        if (c.ClusterId is not null && Clusters.Any(x => x.Id == c.ClusterId)) tab.ClusterId = c.ClusterId;
        RebuildRows();
        return tab;
    }

    public void CloseMany(IEnumerable<BrowserTab> tabs)
    {
        foreach (var t in tabs.ToList()) Close(t);
    }

    public BrowserTab Duplicate(BrowserTab tab)
    {
        var copy = NewTab(tab.Url, tab, true, tab.WorkspaceId);
        copy.Title = tab.Title;
        return copy;
    }

    public void SetPinned(BrowserTab tab, bool pinned)
    {
        if (tab.IsPinned == pinned) return;
        tab.IsPinned = pinned;
        if (pinned)
        {
            tab.ClusterId = null; // pinned tabs are never grouped automatically or by accident
            // keep pinned tabs together at the front of their workspace
            int idx = AllTabs.IndexOf(tab);
            AllTabs.RemoveAt(idx);
            int insertAt = AllTabs.Select((t, i) => (t, i)).Where(x => x.t.WorkspaceId == tab.WorkspaceId && x.t.IsPinned).Select(x => x.i + 1).DefaultIfEmpty(
                AllTabs.Select((t, i) => (t, i)).Where(x => x.t.WorkspaceId == tab.WorkspaceId).Select(x => x.i).DefaultIfEmpty(AllTabs.Count).Min()).Max();
            AllTabs.Insert(Math.Min(insertAt, AllTabs.Count), tab);
        }
        PruneClusters();
        RebuildRows();
        Changed?.Invoke();
    }

    /// <summary>Moves <paramref name="tab"/> so it sits directly before <paramref name="before"/> (or at the end of its workspace when null).</summary>
    public void MoveBefore(BrowserTab tab, BrowserTab? before)
    {
        if (tab == before) return;
        AllTabs.Remove(tab);
        if (before is null)
        {
            int last = AllTabs.Select((t, i) => (t, i)).Where(x => x.t.WorkspaceId == tab.WorkspaceId).Select(x => x.i).DefaultIfEmpty(AllTabs.Count - 1).Max();
            AllTabs.Insert(last + 1, tab);
        }
        else
        {
            tab.WorkspaceId = before.WorkspaceId;
            tab.IsPinned = before.IsPinned;   // dropping next to a pinned tab pins it; next to an unpinned one unpins it
            tab.ClusterId = tab.IsPinned ? null : before.ClusterId;
            AllTabs.Insert(AllTabs.IndexOf(before), tab);
        }
        PruneClusters();
        RebuildRows();
        Changed?.Invoke();
    }

    public void MoveToWorkspace(BrowserTab tab, Workspace target)
    {
        if (tab.WorkspaceId == target.Id) return;
        bool wasActive = tab == ActiveTab;
        tab.WorkspaceId = target.Id;
        tab.ClusterId = null;
        AllTabs.Remove(tab);
        int last = AllTabs.Select((t, i) => (t, i)).Where(x => x.t.WorkspaceId == target.Id).Select(x => x.i).DefaultIfEmpty(AllTabs.Count - 1).Max();
        AllTabs.Insert(last + 1, tab);
        PruneClusters();
        if (wasActive)
        {
            var other = TabsOf(ActiveWorkspace.Id).FirstOrDefault(t => t != tab);
            ActiveTab = null; tab.IsSelected = false;
            if (other is not null) Activate(other); else { RebuildRows(); NewTab(); }
        }
        RebuildRows();
        Changed?.Invoke();
    }

    // ---- clusters ----------------------------------------------------------------------------------------------------

    private static readonly string[] ClusterPalette = { "#8B5CF6", "#38BDF8", "#34D399", "#FBBF24", "#F43F5E", "#FB923C", "#EC4899", "#A3E635" };

    public TabCluster CreateCluster(string name, IEnumerable<BrowserTab> tabs, string? color = null, string emoji = "")
    {
        var list = tabs.Where(t => !t.IsPinned).ToList();
        if (list.Count == 0) throw new InvalidOperationException("Pinned tabs can't be added to a cluster.");
        var ws = list[0].WorkspaceId;
        var c = new TabCluster
        {
            Name = string.IsNullOrWhiteSpace(name) ? "Cluster" : name.Trim(), WorkspaceId = ws, Emoji = emoji,
            Color = color ?? ClusterPalette[Clusters.Count % ClusterPalette.Length],
        };
        Clusters.Add(c);
        // Bring the members together at the position of the first one.
        int at = AllTabs.IndexOf(list[0]);
        foreach (var t in list) { AllTabs.Remove(t); t.ClusterId = c.Id; t.WorkspaceId = ws; }
        at = Math.Min(at, AllTabs.Count);
        foreach (var t in list) AllTabs.Insert(at++, t);
        RebuildRows();
        Changed?.Invoke();
        return c;
    }

    public void AddToCluster(BrowserTab tab, TabCluster cluster)
    {
        if (tab.IsPinned) return;
        tab.ClusterId = cluster.Id;
        if (tab.WorkspaceId != cluster.WorkspaceId) tab.WorkspaceId = cluster.WorkspaceId;
        // place after the cluster's last member
        AllTabs.Remove(tab);
        int last = AllTabs.Select((t, i) => (t, i)).Where(x => x.t.ClusterId == cluster.Id).Select(x => x.i).DefaultIfEmpty(AllTabs.Count - 1).Max();
        AllTabs.Insert(last + 1, tab);
        PruneClusters();
        RebuildRows();
        Changed?.Invoke();
    }

    public void RemoveFromCluster(BrowserTab tab)
    {
        tab.ClusterId = null;
        PruneClusters();
        RebuildRows();
        Changed?.Invoke();
    }

    public void DeleteCluster(TabCluster cluster, bool closeTabs)
    {
        var members = AllTabs.Where(t => t.ClusterId == cluster.Id).ToList();
        if (closeTabs) { foreach (var t in members) Close(t); }
        else foreach (var t in members) t.ClusterId = null;
        Clusters.Remove(cluster);
        RebuildRows();
        Changed?.Invoke();
    }

    public void ToggleCollapsed(TabCluster cluster)
    {
        cluster.Collapsed = !cluster.Collapsed;
        RebuildRows();
        Changed?.Invoke();
    }

    public void MoveClusterToWorkspace(TabCluster cluster, Workspace target)
    {
        foreach (var t in AllTabs.Where(t => t.ClusterId == cluster.Id).ToList()) t.WorkspaceId = target.Id;
        cluster.WorkspaceId = target.Id;
        if (ActiveTab is not null && ActiveTab.WorkspaceId != ActiveWorkspace.Id)
        {
            var other = TabsOf(ActiveWorkspace.Id).FirstOrDefault();
            ActiveTab = null;
            if (other is not null) Activate(other); else NewTab();
        }
        RebuildRows();
        Changed?.Invoke();
    }

    private void PruneClusters()
    {
        foreach (var c in Clusters.ToList())
            if (!AllTabs.Any(t => t.ClusterId == c.Id)) Clusters.Remove(c);
    }

    // ---- workspaces ----------------------------------------------------------------------------------------------------

    public Workspace CreateWorkspace(string name, string icon, string color)
    {
        var w = new Workspace { Name = string.IsNullOrWhiteSpace(name) ? "Workspace" : name.Trim(), Icon = string.IsNullOrWhiteSpace(icon) ? "⭐" : icon, Color = color };
        Workspaces.Add(w);
        Changed?.Invoke();
        return w;
    }

    public Workspace DuplicateWorkspace(Workspace source)
    {
        var copy = CreateWorkspace(source.Name + " copy", source.Icon, source.Color);
        foreach (var t in TabsOf(source.Id).Where(t => !t.IsInternal || t.Url == "wiisb://newtab").ToList())
        {
            var d = new BrowserTab { Url = t.Url, Title = t.Title, WorkspaceId = copy.Id, IsPinned = t.IsPinned, Marker = t.Marker, IsPrivate = _isPrivate, Lifecycle = TabLifecycle.Sleeping };
            AllTabs.Add(d);
            TabAdded?.Invoke(d);
        }
        Changed?.Invoke();
        return copy;
    }

    /// <summary>Deleting a workspace never silently drops the user's tabs: they are moved or explicitly closed.</summary>
    public void DeleteWorkspace(Workspace ws, Workspace? moveTabsTo)
    {
        if (Workspaces.Count <= 1) throw new InvalidOperationException("You need at least one workspace.");
        var tabs = TabsOf(ws.Id).ToList();
        int idx = Workspaces.IndexOf(ws);
        if (moveTabsTo is not null)
        {
            foreach (var t in tabs) { t.WorkspaceId = moveTabsTo.Id; t.ClusterId = null; }
            foreach (var c in Clusters.Where(c => c.WorkspaceId == ws.Id).ToList()) c.WorkspaceId = moveTabsTo.Id;
        }
        else foreach (var t in tabs) { bool a = t == ActiveTab; AllTabs.Remove(t); if (a) ActiveTab = null; TabRemoved?.Invoke(t); }
        foreach (var c in Clusters.Where(c => c.WorkspaceId == ws.Id).ToList()) Clusters.Remove(c);
        Workspaces.Remove(ws);
        if (ActiveWorkspace == ws)
        {
            var next = moveTabsTo ?? Workspaces[Math.Min(idx, Workspaces.Count - 1)];
            SwitchWorkspaceCore(next);
            var tab = ActiveTab is not null && ActiveTab.WorkspaceId == next.Id ? ActiveTab : TabsOf(next.Id).FirstOrDefault();
            if (tab is not null) { ActiveTab = null; Activate(tab); } else NewTab();
        }
        else RebuildRows();
        Changed?.Invoke();
    }

    public void SwitchWorkspace(Workspace ws)
    {
        if (ws == ActiveWorkspace) return;
        SwitchWorkspaceCore(ws);
        var tab = Find(ws.ActiveTabId ?? "") is { } t && t.WorkspaceId == ws.Id ? t : TabsOf(ws.Id).FirstOrDefault();
        if (tab is null) { ActiveTab = null; NewTab(); return; }
        var prev = ActiveTab;
        if (prev is not null) { prev.IsSelected = false; }
        ActiveTab = null;
        Activate(tab);
    }

    private void SwitchWorkspaceCore(Workspace ws)
    {
        foreach (var w in Workspaces) w.IsActive = w == ws;
        ActiveWorkspace = ws;
        RebuildRows();
    }

    public void MoveWorkspace(Workspace ws, int newIndex)
    {
        int old = Workspaces.IndexOf(ws);
        if (old < 0) return;
        newIndex = Math.Clamp(newIndex, 0, Workspaces.Count - 1);
        if (old != newIndex) { Workspaces.Move(old, newIndex); Changed?.Invoke(); }
    }

    // ---- layout ------------------------------------------------------------------------------------------------------

    public void RebuildRows()
    {
        var wsTabs = AllTabs.Where(t => t.WorkspaceId == ActiveWorkspace.Id).ToList();
        Pinned.Clear();
        foreach (var t in wsTabs.Where(t => t.IsPinned)) Pinned.Add(t);

        Rows.Clear();
        var emitted = new HashSet<string>();
        foreach (var t in wsTabs.Where(t => !t.IsPinned))
        {
            if (t.ClusterId is { } cid && Clusters.FirstOrDefault(c => c.Id == cid) is { } cluster)
            {
                if (!emitted.Add(cid)) continue;
                var members = wsTabs.Where(x => x.ClusterId == cid && !x.IsPinned).ToList();
                cluster.Count = members.Count;
                foreach (var m in members) m.ClusterBrush = cluster.Brush;
                Rows.Add(cluster);
                if (!cluster.Collapsed) foreach (var m in members) Rows.Add(m);
            }
            else Rows.Add(t);
        }

        foreach (var t in wsTabs.Where(t => t.ClusterId is null)) t.ClusterBrush = null;
        Strip.Clear();
        foreach (var t in wsTabs.Where(t => t.IsPinned)) Strip.Add(t);
        foreach (var t in wsTabs.Where(t => !t.IsPinned)) Strip.Add(t);
        LayoutChanged?.Invoke();
    }

    public void SelectRelative(int delta)
    {
        var list = AllTabs.Where(t => t.WorkspaceId == ActiveWorkspace.Id).ToList();
        if (list.Count == 0 || ActiveTab is null) return;
        int i = (list.IndexOf(ActiveTab) + delta + list.Count) % list.Count;
        Activate(list[i]);
    }

    public void SelectNumber(int n)
    {
        var list = AllTabs.Where(t => t.WorkspaceId == ActiveWorkspace.Id).ToList();
        if (list.Count == 0) return;
        Activate(n >= 9 ? list[^1] : list[Math.Min(n - 1, list.Count - 1)]);
    }

    public IReadOnlyList<(string Id, string Url, bool Exempt)> DuplicateInput() =>
        AllTabs.Select(t => (t.Id, t.Url, t.SleepExempt)).ToList();

    public IReadOnlyList<TabFacts> Facts() =>
        AllTabs.Where(t => t.WorkspaceId == ActiveWorkspace.Id).Select(t => new TabFacts(t.Id, t.Url, t.Title, t.IsPinned, t.ClusterId, t.OpenerId)).ToList();
}
