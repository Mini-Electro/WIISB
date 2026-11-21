using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Tabs;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Views;

public partial class MainWindow
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly DispatcherTimer _suggestTimer = new() { Interval = TimeSpan.FromMilliseconds(120) };
    private CancellationTokenSource? _suggestCts;
    private bool _settingAddress;
    private string _typedText = "";

    private sealed record Suggestion(string Kind, string Title, string Subtitle, string Url, string Glyph, BrowserTab? Tab = null);

    // ---- toolbar state --------------------------------------------------------------------------------------------------

    private void UpdateToolbar()
    {
        var t = Tabs.ActiveTab;
        if (t is null) return;
        BackBtn.IsEnabled = t.CanGoBack;
        ForwardBtn.IsEnabled = t.CanGoForward;
        ReloadBtn.Content = t.IsLoading ? "" : "";
        ReloadBtn.ToolTip = t.IsLoading ? "Stop loading" : "Reload (Ctrl+R)";

        if (!AddressBox.IsKeyboardFocused)
        {
            _settingAddress = true;
            bool blank = t.Url is "wiisb://newtab" or "" or "about:blank";
            AddressBox.Text = blank ? "" : t.DisplayUrl;
            AddressHint.Visibility = blank ? Visibility.Visible : Visibility.Collapsed;
            _settingAddress = false;
        }

        (SecurityBtn.Content, SecurityBtn.ToolTip, SecurityBtn.Foreground) = t.Security switch
        {
            SecurityState.Secure => ("", "Secure connection (HTTPS)", (Brush)new SolidColorBrush(Color.FromRgb(0x34, 0xD3, 0x99))),
            SecurityState.Insecure => ("", "Not secure — this site doesn't use HTTPS", new SolidColorBrush(Color.FromRgb(0xFB, 0xBF, 0x24))),
            SecurityState.Error => ("", "This page didn't load", new SolidColorBrush(Color.FromRgb(0xF4, 0x3F, 0x5E))),
            SecurityState.Local => ("", "Local address", (Brush)FindResource("TextMutedBrush")),
            _ => ("", "WIISBROWSING page", (Brush)FindResource("AccentSecondaryBrush")),
        };

        bool bookmarked = BookmarkStore.IsValidUrl(t.Url) && Data.Bookmarks.IsBookmarked(t.Url);
        BookmarkBtn.Content = bookmarked ? "" : "";
        BookmarkBtn.Foreground = bookmarked ? (Brush)FindResource("AccentSecondaryBrush") : (Brush)FindResource("TextMutedBrush");
        BookmarkBtn.Visibility = BookmarkStore.IsValidUrl(t.Url) && !t.IsInternal ? Visibility.Visible : Visibility.Collapsed;
        ShieldBtn.Visibility = t.IsInternal ? Visibility.Collapsed : Visibility.Visible;
        UpdateShieldCount();
        UpdateZoomButton();
        Title = (string.IsNullOrWhiteSpace(t.Title) ? t.DisplayTitle : t.Title) + (IsPrivate ? " — Private" : " — WIISBROWSING");
    }

    private void UpdateShieldCount()
    {
        var t = Tabs.ActiveTab;
        bool exempt = t is not null && AppHost.AdBlock.IsSiteExempt(t.Host);
        ShieldCount.Text = t is { BlockedCount: > 0 } && !exempt ? t.BlockedCount.ToString() : "";
        ShieldBtn.Foreground = !AppHost.AdBlock.Enabled || exempt ? (Brush)FindResource("TextMutedBrush") : (Brush)FindResource("AccentSecondaryBrush");
        ShieldBtn.ToolTip = !AppHost.AdBlock.Enabled ? "Ad blocking is off" : exempt ? "Blocking is off for this site" : $"{t?.BlockedCount ?? 0} blocked on this page";
    }

    private void UpdateZoomButton()
    {
        var t = Tabs.ActiveTab;
        bool zoomed = t is not null && Math.Abs(t.Zoom - 1.0) > 0.01;
        ZoomBtn.Visibility = zoomed ? Visibility.Visible : Visibility.Collapsed;
        if (zoomed) ZoomBtn.Content = "  " + t!.ZoomText;
    }

    private void UpdatePromptBar()
    {
        var p = Tabs.ActiveTab?.Prompt;
        if (p is null) { PromptBar.Visibility = Visibility.Collapsed; return; }
        PromptOrigin.Text = p.Origin;
        PromptText.Text = p.Description;
        bool external = p.Kind == "external";
        PromptAllow.Content = external ? "Open" : "Allow while visiting";
        PromptAlways.Visibility = external ? Visibility.Collapsed : Visibility.Visible;
        PromptBar.Visibility = Visibility.Visible;
    }

    private void PromptAllowOnce_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.Prompt?.Decide?.Invoke("allow-once");
    private void PromptAlways_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.Prompt?.Decide?.Invoke("allow-always");
    private void PromptBlock_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.Prompt?.Decide?.Invoke("block-always");

    // ---- back / forward / reload ----------------------------------------------------------------------------------------

    private void Back_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.View?.GoBack();
    private void Forward_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.View?.GoForward();
    private void Reload_Click(object s, RoutedEventArgs e)
    {
        var t = Tabs.ActiveTab;
        if (t is null) return;
        if (t.IsLoading) t.View?.Stop(); else { t.Error = null; t.View?.Reload(); }
    }
    private void Home_Click(object s, RoutedEventArgs e) => NavigateActive(HomeUrl());
    private string HomeUrl() => Data.Settings.Get(SettingKeys.HomeUrl) is { Length: > 0 } h && UrlClassifier.Classify(h, CurrentSearchEngine()).Kind is NavKind.Url or NavKind.Internal ? UrlClassifier.Classify(h, CurrentSearchEngine()).Url : "wiisb://newtab";
    private void ZoomReset_Click(object s, RoutedEventArgs e) => SetZoom(1.0);

    public void SetZoom(double factor)
    {
        if (Tabs.ActiveTab is { View: { } v } tab)
        {
            v.Control.ZoomFactor = Math.Clamp(factor, 0.25, 5.0);
            tab.Zoom = v.Control.ZoomFactor;   // read back what the engine applied
        }
    }

    public void ZoomBy(double delta) { if (Tabs.ActiveTab?.View is { } v) SetZoom(v.Control.ZoomFactor + delta); }

    // ---- address bar ------------------------------------------------------------------------------------------------------

    public void FocusAddressBar(bool selectAll = true)
    {
        AddressBox.Focus();
        Keyboard.Focus(AddressBox);
        if (selectAll) AddressBox.SelectAll();
    }

    private void AddressBox_GotKeyboardFocus(object s, KeyboardFocusChangedEventArgs e)
    {
        var t = Tabs.ActiveTab;
        _settingAddress = true;
        AddressBox.Text = t is null || t.Url is "wiisb://newtab" or "about:blank" ? "" : t.Url;
        _settingAddress = false;
        AddressHint.Visibility = Visibility.Collapsed;
        AddressBox.SelectAll();
        AddressPill.BorderBrush = (Brush)FindResource("AccentPrimaryBrush");
    }

    private void AddressBox_LostKeyboardFocus(object s, KeyboardFocusChangedEventArgs e)
    {
        AddressPill.BorderBrush = (Brush)FindResource("BorderSubtleBrush");
        // keep the list open while the user clicks a suggestion
        Dispatcher.BeginInvoke(() => { if (!SuggestList.IsMouseOver) { SuggestPopup.IsOpen = false; UpdateToolbar(); } }, DispatcherPriority.Background);
    }

    private void AddressBox_PreviewMouseDown(object s, MouseButtonEventArgs e)
    {
        if (!AddressBox.IsKeyboardFocused) { AddressBox.Focus(); e.Handled = true; }
    }

    private void AddressBox_TextChanged(object s, TextChangedEventArgs e)
    {
        if (_settingAddress) return;
        _typedText = AddressBox.Text;
        _suggestTimer.Stop();
        _suggestTimer.Tick -= SuggestTick;
        _suggestTimer.Tick += SuggestTick;
        _suggestTimer.Start();
    }

    private async void SuggestTick(object? s, EventArgs e)
    {
        _suggestTimer.Stop();
        _suggestCts?.Cancel();
        var cts = _suggestCts = new CancellationTokenSource();
        var text = _typedText.Trim();
        if (text.Length == 0 || !AddressBox.IsKeyboardFocused) { SuggestPopup.IsOpen = false; return; }

        var list = new List<Suggestion>();
        var target = UrlClassifier.Classify(text, CurrentSearchEngine());
        list.Add(target.Kind == NavKind.Search
            ? new Suggestion("search", text, $"Search with {CurrentSearchEngine().Name}", target.Url, "")
            : new Suggestion("go", text, target.Kind == NavKind.Blocked ? target.Reason ?? "" : "Go to this address", target.Url, ""));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { target.Url };

        foreach (var tab in Tabs.AllTabs.Where(t => !t.IsInternal && (Fuzzy.Score(text, t.Title + " " + t.Url) ?? -1) > 0).OrderByDescending(t => Fuzzy.Score(text, t.Title + " " + t.Url)).Take(3))
            list.Add(new Suggestion("tab", tab.DisplayTitle, "Switch to this tab", tab.Url, "", tab));
        foreach (var b in Data.Bookmarks.Search(text, 3))
            if (seen.Add(b.Url)) list.Add(new Suggestion("bookmark", b.Title, b.Url, b.Url, ""));
        if (Data.History is { } h)
            foreach (var he in h.Suggest(text, 5))
                if (seen.Add(he.Url)) list.Add(new Suggestion("history", string.IsNullOrWhiteSpace(he.Title) ? he.Url : he.Title, he.Url, he.Url, ""));
        ShowSuggestions(list);

        // Optional network suggestions: off by default, because they send what you type to the search provider.
        if (Data.Settings.GetBool(SettingKeys.SearchSuggest) && target.Kind == NavKind.Search)
        {
            try
            {
                var url = SearchEngines.BuildSuggestUrl(CurrentSearchEngine(), text);
                if (url is null) return;
                using var resp = await Http.GetAsync(url, cts.Token);
                if (!resp.IsSuccessStatusCode || cts.IsCancellationRequested) return;
                using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(cts.Token));
                if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() < 2) return;
                foreach (var el in doc.RootElement[1].EnumerateArray().Take(5))
                {
                    var phrase = el.ValueKind == JsonValueKind.String ? el.GetString() : null;
                    if (string.IsNullOrWhiteSpace(phrase) || phrase.Equals(text, StringComparison.OrdinalIgnoreCase)) continue;
                    list.Add(new Suggestion("search", phrase, "Search suggestion", SearchEngines.BuildUrl(CurrentSearchEngine(), phrase), ""));
                }
                if (!cts.IsCancellationRequested && AddressBox.IsKeyboardFocused) ShowSuggestions(list);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or OperationCanceledException) { }
        }
    }

    private void ShowSuggestions(List<Suggestion> list)
    {
        SuggestList.Items.Clear();
        foreach (var s in list)
        {
            var row = new Grid { Height = 40, Margin = new Thickness(6, 0, 6, 0), Background = Brushes.Transparent, Tag = s };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Children.Add(new TextBlock { Text = s.Glyph, FontFamily = (FontFamily)FindResource("IconFont"), FontSize = 14, Foreground = (Brush)FindResource("TextMutedBrush"), VerticalAlignment = VerticalAlignment.Center });
            var texts = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            texts.Children.Add(new TextBlock { Text = s.Title, Foreground = (Brush)FindResource("TextPrimaryBrush"), TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 13.5 });
            if (!string.IsNullOrEmpty(s.Subtitle)) texts.Children.Add(new TextBlock { Text = s.Subtitle, Foreground = (Brush)FindResource("TextMutedBrush"), TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 11.5 });
            Grid.SetColumn(texts, 1);
            row.Children.Add(texts);
            SuggestList.Items.Add(new ListBoxItem
            {
                Content = row, Tag = s, Padding = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Template = SuggestItemTemplate(),
            });
        }
        if (SuggestList.Items.Count > 0) SuggestList.SelectedIndex = 0;
        SuggestBorder.Width = Math.Max(360, AddressPill.ActualWidth - 24);
        SuggestPopup.IsOpen = SuggestList.Items.Count > 0 && AddressBox.IsKeyboardFocused;
    }

    private static ControlTemplate SuggestItemTemplate()
    {
        var xaml = "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='ListBoxItem'>" +
                   "<Border x:Name='b' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' CornerRadius='8' Background='Transparent'><ContentPresenter/></Border>" +
                   "<ControlTemplate.Triggers><Trigger Property='IsSelected' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource HoverBrush}'/></Trigger>" +
                   "<Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource HoverBrush}'/></Trigger></ControlTemplate.Triggers></ControlTemplate>";
        return (ControlTemplate)System.Windows.Markup.XamlReader.Parse(xaml);
    }

    private void SuggestList_MouseUp(object s, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is DependencyObject d && FindParent<ListBoxItem>(d) is { Tag: Suggestion sg }) { AcceptSuggestion(sg, Keyboard.Modifiers.HasFlag(ModifierKeys.Control)); e.Handled = true; }
    }

    private void AcceptSuggestion(Suggestion s, bool newTab)
    {
        SuggestPopup.IsOpen = false;
        if (s.Tab is not null) { Tabs.Activate(s.Tab); return; }
        Open(s.Url, newTab);
    }

    private void Open(string url, bool newTab)
    {
        if (newTab) Tabs.NewTab(url, Tabs.ActiveTab);
        else NavigateActive(url);
        Dispatcher.BeginInvoke(() => Tabs.ActiveTab?.View?.Control.Focus(), DispatcherPriority.Background);
    }

    private void AddressBox_PreviewKeyDown(object s, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Down when SuggestPopup.IsOpen: SuggestList.SelectedIndex = Math.Min(SuggestList.SelectedIndex + 1, SuggestList.Items.Count - 1); ScrollSuggest(); e.Handled = true; break;
            case Key.Up when SuggestPopup.IsOpen: SuggestList.SelectedIndex = Math.Max(SuggestList.SelectedIndex - 1, 0); ScrollSuggest(); e.Handled = true; break;
            case Key.Escape:
                if (SuggestPopup.IsOpen) SuggestPopup.IsOpen = false;
                else { Keyboard.ClearFocus(); Tabs.ActiveTab?.View?.Control.Focus(); UpdateToolbar(); }
                e.Handled = true; break;
            case Key.Enter:
                bool newTab = Keyboard.Modifiers.HasFlag(ModifierKeys.Alt);
                if (SuggestPopup.IsOpen && SuggestList.SelectedItem is ListBoxItem { Tag: Suggestion sg } && SuggestList.SelectedIndex > 0) { AcceptSuggestion(sg, newTab); e.Handled = true; break; }
                SubmitAddress(AddressBox.Text, newTab);
                e.Handled = true; break;
        }
    }

    private void ScrollSuggest() { if (SuggestList.SelectedItem is { } it) SuggestList.ScrollIntoView(it); }

    private void SubmitAddress(string text, bool newTab)
    {
        SuggestPopup.IsOpen = false;
        var target = UrlClassifier.Classify(text, CurrentSearchEngine());
        switch (target.Kind)
        {
            case NavKind.Url or NavKind.Search or NavKind.Internal: Open(target.Url, newTab); break;
            case NavKind.External:
                if (Dialogs.Confirm(this, "Open another app?", $"This link opens another application:\n{target.Url}", "Open", "Cancel"))
                {
                    var scheme = target.Url.Contains(':') ? target.Url[..target.Url.IndexOf(':')] : "";
                    if (SafeExternalSchemes.Contains(scheme)) { try { Process.Start(new ProcessStartInfo(target.Url) { UseShellExecute = true }); } catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Couldn't open that app."); } }
                    else ShowToast("That kind of link can't be opened from the browser.");
                }
                break;
            default: ShowToast(target.Reason ?? "That can't be opened."); break;
        }
    }

    // ---- security & shield popovers -----------------------------------------------------------------------------------------

    private void Security_Click(object s, RoutedEventArgs e)
    {
        var t = Tabs.ActiveTab;
        if (t is null) return;
        SecurityContent.Children.Clear();
        string head, body;
        switch (t.Security)
        {
            case SecurityState.Secure: head = "Connection is secure"; body = "Information you send to this site is encrypted. HTTPS protects the connection — it does not mean the site itself is trustworthy."; break;
            case SecurityState.Insecure: head = "Connection is not secure"; body = "This site doesn't use HTTPS, so others on the network could read or change what you send. Don't enter passwords or card details here."; break;
            case SecurityState.Local: head = "Local address"; body = "This page comes from your own computer or network, not from the internet."; break;
            case SecurityState.Error: head = "This page didn't load"; body = t.Error?.Message ?? "The connection failed."; break;
            default: head = "WIISBROWSING page"; body = "This page is part of the browser. Websites can't control it."; break;
        }
        SecurityContent.Children.Add(new TextBlock { Text = head, FontWeight = FontWeights.SemiBold, FontSize = 15, Foreground = (Brush)FindResource("TextPrimaryBrush") });
        SecurityContent.Children.Add(new TextBlock { Text = t.Host, Foreground = (Brush)FindResource("AccentSecondaryBrush"), Margin = new Thickness(0, 2, 0, 8) });
        SecurityContent.Children.Add(new TextBlock { Text = body, TextWrapping = TextWrapping.Wrap, Foreground = (Brush)FindResource("TextMutedBrush"), LineHeight = 19 });

        if (!t.IsInternal && !string.IsNullOrEmpty(t.Host))
        {
            var origin = UrlClassifier.OriginOf(t.Url);
            var perms = Data.Permissions.List().Where(p => p.Origin == origin).ToList();
            if (perms.Count > 0)
            {
                SecurityContent.Children.Add(new TextBlock { Text = "Permissions for this site", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 14, 0, 4), Foreground = (Brush)FindResource("TextPrimaryBrush") });
                foreach (var p in perms)
                {
                    var row = new DockPanel { Margin = new Thickness(0, 2, 0, 2) };
                    var reset = new Button { Content = "Reset", Style = (Style)FindResource("GhostButton"), Padding = new Thickness(8, 2, 8, 2), FontSize = 12 };
                    reset.Click += (_, _) => { Data.Permissions.Revoke(p.Origin, p.Permission); SecurityPopup.IsOpen = false; };
                    DockPanel.SetDock(reset, Dock.Right);
                    row.Children.Add(reset);
                    row.Children.Add(new TextBlock { Text = $"{char.ToUpper(p.Permission[0])}{p.Permission[1..]}: {(p.State == PermissionStore.Allow ? "Allowed" : "Blocked")}", VerticalAlignment = VerticalAlignment.Center, Foreground = (Brush)FindResource("TextMutedBrush") });
                    SecurityContent.Children.Add(row);
                }
            }
            var clear = new Button { Content = "Clear cookies and data for this site", Style = (Style)FindResource("PillButton"), Margin = new Thickness(0, 14, 0, 0) };
            clear.Click += async (_, _) => { SecurityPopup.IsOpen = false; await ClearSiteDataAsync(t); };
            SecurityContent.Children.Add(clear);
        }
        SecurityPopup.IsOpen = true;
    }

    /// <summary>Deletes this site's cookies and page storage (local, session, IndexedDB, caches) and reloads it.</summary>
    private async Task ClearSiteDataAsync(BrowserTab tab)
    {
        if (tab.View?.Core is not { } core) return;
        try
        {
            var cookies = await core.CookieManager.GetCookiesAsync(tab.Url);
            foreach (var c in cookies) core.CookieManager.DeleteCookie(c);
            await core.ExecuteScriptAsync("try{localStorage.clear();sessionStorage.clear();}catch(e){};(async()=>{try{for(const d of (await indexedDB.databases()))indexedDB.deleteDatabase(d.name);for(const k of await caches.keys())await caches.delete(k);}catch(e){}})()");
            core.Reload();
            ShowToast($"Cleared {cookies.Count} cookie{(cookies.Count == 1 ? "" : "s")} and the stored data for {tab.Host}.");
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { ShowToast("Couldn't clear this site's data."); }
    }

    private void Shield_Click(object s, RoutedEventArgs e)
    {
        var t = Tabs.ActiveTab;
        if (t is null) return;
        var blocker = AppHost.AdBlock;
        ShieldContent.Children.Clear();
        bool exempt = blocker.IsSiteExempt(t.Host);
        ShieldContent.Children.Add(new TextBlock { Text = !blocker.Enabled ? "Ad blocking is off" : exempt ? "Blocking is off for this site" : "Ads and trackers are blocked", FontWeight = FontWeights.SemiBold, FontSize = 15, Foreground = (Brush)FindResource("TextPrimaryBrush") });
        ShieldContent.Children.Add(new TextBlock { Text = t.Host, Foreground = (Brush)FindResource("AccentSecondaryBrush"), Margin = new Thickness(0, 2, 0, 10) });

        var counts = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        counts.ColumnDefinitions.Add(new ColumnDefinition()); counts.ColumnDefinitions.Add(new ColumnDefinition());
        Stat(counts, 0, t.BlockedCount.ToString(), "blocked on this page");
        Stat(counts, 1, blocker.Counters.Total.ToString(), "blocked in total");
        ShieldContent.Children.Add(counts);

        if (!t.IsInternal && !string.IsNullOrEmpty(t.Host))
        {
            var site = new CheckBox { Style = (Style)FindResource("Switch"), Content = "Block ads on this site", IsChecked = !exempt, Margin = new Thickness(0, 4, 0, 6) };
            site.Click += (_, _) =>
            {
                bool on = site.IsChecked == true;
                var root = UrlClassifier.RegistrableDomain(t.Host);
                blocker.SetSiteException(root, !on);
                if (on) Data.AdBlockExceptions.Remove(root); else Data.AdBlockExceptions.Add(root);
                t.View?.Reload();
                UpdateShieldCount();
            };
            ShieldContent.Children.Add(site);
        }
        var recent = blocker.Counters.Recent(5);
        if (recent.Count > 0)
        {
            ShieldContent.Children.Add(new TextBlock { Text = "Recently blocked", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 8, 0, 4), Foreground = (Brush)FindResource("TextPrimaryBrush") });
            foreach (var r in recent)
                ShieldContent.Children.Add(new TextBlock { Text = r.Host, FontSize = 11.5, Foreground = (Brush)FindResource("TextMutedBrush"), TextTrimming = TextTrimming.CharacterEllipsis });
        }
        ShieldContent.Children.Add(new TextBlock
        {
            Text = $"{blocker.RuleCount:N0} domain rules loaded. Blocking works by host name; it can't catch ads served from the site's own domain.",
            TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Foreground = (Brush)FindResource("TextMutedBrush"), Margin = new Thickness(0, 10, 0, 0),
        });
        var settings = new Button { Content = "Privacy settings", Style = (Style)FindResource("PillButton"), Margin = new Thickness(0, 10, 0, 0) };
        settings.Click += (_, _) => { ShieldPopup.IsOpen = false; OpenInternal("settings#privacy"); };
        ShieldContent.Children.Add(settings);
        ShieldPopup.IsOpen = true;
    }

    private void Stat(Grid g, int col, string value, string label)
    {
        var sp = new StackPanel();
        sp.Children.Add(new TextBlock { Text = value, FontSize = 24, FontWeight = FontWeights.SemiBold, Foreground = (Brush)FindResource("TextPrimaryBrush") });
        sp.Children.Add(new TextBlock { Text = label, FontSize = 11.5, Foreground = (Brush)FindResource("TextMutedBrush") });
        Grid.SetColumn(sp, col);
        g.Children.Add(sp);
    }

    // ---- bookmarks ----------------------------------------------------------------------------------------------------------

    private void Bookmark_Click(object s, RoutedEventArgs e) { if (Tabs.ActiveTab is { } t) ToggleBookmark(t); }

    public void ToggleBookmark(BrowserTab t)
    {
        if (!BookmarkStore.IsValidUrl(t.Url) || t.IsInternal) { ShowToast("This page can't be bookmarked."); return; }
        if (Data.Bookmarks.FindByUrl(t.Url) is { } b) { Data.Bookmarks.Remove(b.Id); ShowToast("Bookmark removed."); }
        else { Data.Bookmarks.Add(t.Url, t.DisplayTitle); ShowToast("Bookmarked. Find it in the bookmarks bar or the sidebar."); }
        UpdateToolbar();
        UpdateBookmarkBar();
    }

    private void BookmarkTab(BrowserTab t)
    {
        if (!BookmarkStore.IsValidUrl(t.Url) || t.IsInternal) return;
        if (!Data.Bookmarks.IsBookmarked(t.Url)) Data.Bookmarks.Add(t.Url, t.DisplayTitle);
        ShowToast("Bookmarked.");
        UpdateToolbar(); UpdateBookmarkBar();
    }

    private void UpdateBookmarkBar()
    {
        var mode = Data.Settings.Get(SettingKeys.BookmarkBar);
        bool show = mode == "always" || (mode == "newtab" && Tabs.ActiveTab?.Url == "wiisb://newtab");
        BookmarkBar.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (!show) return;
        BookmarkItems.Children.Clear();
        foreach (var f in Data.Bookmarks.Folders(null))
        {
            var folder = f;
            var b = new Button { Style = (Style)FindResource("GhostButton"), Padding = new Thickness(10, 4, 10, 4), Content = "📁 " + folder.Name, Height = 26 };
            b.Click += (_, _) =>
            {
                var m = new ContextMenu { PlacementTarget = b };
                foreach (var bm in Data.Bookmarks.InFolder(folder.Id)) { var u = bm.Url; m.Items.Add(Item(bm.Title, () => Open(u, false))); }
                if (m.Items.Count == 0) m.Items.Add(Item("Empty folder", null, null, null, false));
                m.IsOpen = true;
            };
            BookmarkItems.Children.Add(b);
        }
        foreach (var bm in Data.Bookmarks.InFolder(null).Take(30))
        {
            var url = bm.Url;
            var host = UrlClassifier.HostOf(url);
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            if (AppHost.Favicons.Get(host) is { } icon) panel.Children.Add(new Image { Source = icon, Width = 14, Height = 14, Margin = new Thickness(0, 0, 6, 0) });
            panel.Children.Add(new TextBlock { Text = bm.Title, MaxWidth = 160, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center });
            var b = new Button { Style = (Style)FindResource("GhostButton"), Padding = new Thickness(10, 4, 10, 4), Content = panel, Height = 26, ToolTip = url };
            b.Click += (_, _) => Open(url, Keyboard.Modifiers.HasFlag(ModifierKeys.Control));
            var id = bm.Id;
            b.MouseRightButtonUp += (_, _) =>
            {
                var m = new ContextMenu { PlacementTarget = b };
                m.Items.Add(Item("Open in new tab", () => Open(url, true)));
                m.Items.Add(Item("Remove bookmark", () => { Data.Bookmarks.Remove(id); UpdateBookmarkBar(); UpdateToolbar(); }, ""));
                m.IsOpen = true;
            };
            BookmarkItems.Children.Add(b);
        }
    }

    // ---- find in page --------------------------------------------------------------------------------------------------------

    public void ShowFind()
    {
        FindBar.Visibility = Visibility.Visible;
        FindBox.Focus();
        FindBox.SelectAll();
        if (!string.IsNullOrEmpty(FindBox.Text)) StartFind();
    }

    public void CloseFind()
    {
        FindBar.Visibility = Visibility.Collapsed;
        try { Tabs.ActiveTab?.View?.Core?.Find?.Stop(); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
        Tabs.ActiveTab?.View?.Control.Focus();
    }

    private void StartFind()
    {
        if (Tabs.ActiveTab?.View?.Core is not { } core || Environment is null) return;
        var term = FindBox.Text;
        if (string.IsNullOrEmpty(term)) { try { core.Find?.Stop(); } catch (Exception ex) when (ex is InvalidOperationException) { } FindCount.Text = ""; return; }
        var opts = Environment.CreateFindOptions();
        opts.FindTerm = term;
        opts.IsCaseSensitive = FindCase.IsChecked == true;
        opts.ShouldHighlightAllMatches = true;
        opts.SuppressDefaultFindDialog = true;
        _ = core.Find?.StartAsync(opts);
    }

    private void FindBox_TextChanged(object s, TextChangedEventArgs e) => StartFind();
    private void FindCase_Changed(object s, RoutedEventArgs e) => StartFind();
    private void FindNext_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.View?.Core?.Find?.FindNext();
    private void FindPrev_Click(object s, RoutedEventArgs e) => Tabs.ActiveTab?.View?.Core?.Find?.FindPrevious();
    private void FindClose_Click(object s, RoutedEventArgs e) => CloseFind();

    private void FindBox_PreviewKeyDown(object s, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { if (Keyboard.Modifiers == ModifierKeys.Shift) FindPrev_Click(s, e); else FindNext_Click(s, e); e.Handled = true; }
        else if (e.Key == Key.Escape) { CloseFind(); e.Handled = true; }
    }

    // ---- downloads ---------------------------------------------------------------------------------------------------------------

    private void UpdateDownloadsIndicator()
    {
        bool active = Downloads.ActiveCount > 0;
        DownloadsBar.Visibility = active ? Visibility.Visible : Visibility.Collapsed;
        var f = Downloads.OverallFraction;
        DownloadsBar.IsIndeterminate = active && f is null;
        if (f is { } v) DownloadsBar.Value = v;
        DownloadsBtn.Foreground = active ? (Brush)FindResource("AccentSecondaryBrush") : (Brush)FindResource("TextMutedBrush");
        DownloadsEmpty.Visibility = Downloads.Items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void TabSearch_Click(object s, RoutedEventArgs e) => ShowTabSearch();
    private void Downloads_Click(object s, RoutedEventArgs e) => ShowDownloadsPopover();

    public void ShowDownloadsPopover()
    {
        UpdateDownloadsIndicator();
        DownloadsPopup.IsOpen = true;
    }

    private static DownloadItem? Dl(object s) => (s as FrameworkElement)?.Tag as DownloadItem;
    private void DlPause_Click(object s, RoutedEventArgs e) { if (Dl(s) is { } d) Downloads.Pause(d); }
    private void DlResume_Click(object s, RoutedEventArgs e) { if (Dl(s) is { } d) Downloads.Resume(d); }
    private void DlCancel_Click(object s, RoutedEventArgs e) { if (Dl(s) is { } d) Downloads.Cancel(d); }
    private void DlRemove_Click(object s, RoutedEventArgs e) { if (Dl(s) is { } d) Downloads.Remove(d); }
    private void DlClear_Click(object s, RoutedEventArgs e) => Downloads.ClearFinished();
    private void DlOpenPage_Click(object s, RoutedEventArgs e) { DownloadsPopup.IsOpen = false; OpenInternal("downloads"); }

    private void DlFolder_Click(object s, RoutedEventArgs e)
    {
        if (Dl(s) is not { } d) return;
        try
        {
            if (File.Exists(d.Path)) Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{d.Path}\"") { UseShellExecute = true });
            else if (Directory.Exists(Path.GetDirectoryName(d.Path))) Process.Start(new ProcessStartInfo("explorer.exe", $"\"{Path.GetDirectoryName(d.Path)}\"") { UseShellExecute = true });
            else ShowToast("That folder no longer exists.");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Couldn't open the folder."); }
    }

    private void DlOpen_Click(object s, RoutedEventArgs e)
    {
        if (Dl(s) is not { } d) return;
        if (!File.Exists(d.Path)) { ShowToast("The file was moved or deleted."); return; }
        if (d.IsRisky && !Dialogs.Confirm(this, "Open this file?", $"{d.FileName} is a program or script. Only open it if you trust where it came from.\n\nWIISBROWSING never runs downloads on its own.", "Open anyway", "Cancel")) return;
        try { Process.Start(new ProcessStartInfo(d.Path) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Windows couldn't open that file."); }
    }

    // ---- main menu & profile menu -----------------------------------------------------------------------------------------------------

    private void Menu_Click(object s, RoutedEventArgs e)
    {
        var m = new ContextMenu { PlacementTarget = MenuBtn, Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom };
        MenuItem C(string id, string label, string? icon = null)
        {
            var c = Commands.Get(id);
            return Item(label, () => Commands.Execute(id), icon, ShortcutText(id), c?.Available ?? false);
        }
        m.Items.Add(C("tab.new", "New tab", ""));
        m.Items.Add(C("window.new", "New window", ""));
        m.Items.Add(C("window.private", "New private window", ""));
        m.Items.Add(new Separator());
        m.Items.Add(C("panel.bookmarks", "Bookmarks", ""));
        m.Items.Add(C("page.history", "History", ""));
        m.Items.Add(C("page.downloads", "Downloads", ""));
        m.Items.Add(C("panel.notes", "Notes", ""));
        m.Items.Add(new Separator());
        var zoom = new MenuItem { Header = $"Zoom ({Math.Round((Tabs.ActiveTab?.Zoom ?? 1) * 100)}%)" };
        zoom.Items.Add(C("zoom.in", "Zoom in")); zoom.Items.Add(C("zoom.out", "Zoom out")); zoom.Items.Add(C("zoom.reset", "Reset zoom"));
        m.Items.Add(zoom);
        m.Items.Add(C("page.find", "Find in page", ""));
        m.Items.Add(C("page.print", "Print…", ""));
        m.Items.Add(C("page.screenshot", "Take screenshot", ""));
        m.Items.Add(C("page.reader", "Reader mode", ""));
        m.Items.Add(C("page.readAloud", "Read aloud", ""));
        m.Items.Add(C("page.devtools", "Developer tools", ""));
        m.Items.Add(C("view.fullscreen", "Full screen", ""));
        m.Items.Add(new Separator());
        m.Items.Add(C("page.performance", "WIISB Control (performance)", ""));
        m.Items.Add(C("page.themes", "Themes", ""));
        m.Items.Add(C("page.settings", "Settings", ""));
        m.Items.Add(C("page.about", "About WIISBROWSING", ""));
        m.Items.Add(new Separator());
        m.Items.Add(C("app.exit", "Exit", ""));
        m.IsOpen = true;
    }

    private void Profile_Click(object s, RoutedEventArgs e)
    {
        var m = new ContextMenu { PlacementTarget = ProfileBtn };
        foreach (var p in AppHost.Profiles.List())
        {
            var pi = p;
            m.Items.Add(Item((pi.Id == Profile.Id ? "✓  " : "     ") + pi.Name, () =>
            {
                if (pi.Id == Profile.Id) return;
                var existing = AppHost.Windows.FirstOrDefault(w => !w.IsPrivate && w.Profile.Id == pi.Id);
                if (existing is not null) existing.BringToFront(); else AppHost.OpenWindow(pi, false);
            }));
        }
        m.Items.Add(new Separator());
        m.Items.Add(Item("Add profile…", () => AddProfileDialog(), ""));
        m.Items.Add(Item("Manage profiles", () => OpenInternal("profiles"), ""));
        m.Items.Add(Item("Guest / private window", () => Commands.Execute("window.private"), ""));
        m.IsOpen = true;
    }

    public void AddProfileDialog()
    {
        var name = Dialogs.Input(this, "New profile", "Profile name (for example Work or Gaming)", "", 40);
        if (string.IsNullOrWhiteSpace(name)) return;
        try { var p = AppHost.Profiles.Create(name, "#8B5CF6"); AppHost.OpenWindow(p, false); }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { Dialogs.Message(this, "Couldn't add the profile", ex.Message); }
    }

    // ---- print, screenshot, devtools ----------------------------------------------------------------------------------------------------

    public void PrintPage()
    {
        try { Tabs.ActiveTab?.View?.Core?.ShowPrintUI(CoreWebView2PrintDialogKind.Browser); }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { ShowToast("Printing isn't available right now."); }
    }

    public async Task SavePdfAsync()
    {
        if (Tabs.ActiveTab?.View?.Core is not { } core) return;
        var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "PDF document (*.pdf)|*.pdf", FileName = SanitizeName(Tabs.ActiveTab.DisplayTitle) + ".pdf" };
        if (dlg.ShowDialog(this) != true) return;
        try { await core.PrintToPdfAsync(dlg.FileName); ShowToast("Saved as PDF."); }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Runtime.InteropServices.COMException) { ShowToast("Couldn't save the PDF."); }
    }

    private static string SanitizeName(string s) { foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_'); return s.Length > 80 ? s[..80] : s; }

    /// <summary>Captures the visible part of the page. (Full-page capture is not implemented, so the menu says "screenshot", not "full page".)</summary>
    public async Task TakeScreenshotAsync()
    {
        if (Tabs.ActiveTab?.View is not { IsReady: true } v) return;
        try
        {
            var png = await v.CapturePngAsync();
            if (png is null || png.Length == 0) return;
            Directory.CreateDirectory(AppHost.Paths.Screenshots);
            var file = Path.Combine(AppHost.Paths.Screenshots, $"WIISBROWSING {DateTime.Now:yyyy-MM-dd HH-mm-ss}.png");
            await File.WriteAllBytesAsync(file, png);
            var bmp = new System.Windows.Media.Imaging.BitmapImage();
            bmp.BeginInit(); bmp.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad; bmp.StreamSource = new MemoryStream(png); bmp.EndInit();
            Clipboard.SetImage(bmp);
            ShowToast($"Screenshot saved and copied. {file}");
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException)
        { ShowToast("Couldn't take the screenshot."); }
    }

    public void ShowDevTools() => Tabs.ActiveTab?.View?.Core?.OpenDevToolsWindow();

    public async Task ReadAloudAsync()
    {
        if (Tabs.ActiveTab?.View is not { IsReady: true } v) return;
        var sel = await v.RunScriptAsync("window.getSelection().toString()");
        var text = JsonSerializer.Deserialize<string>(sel ?? "\"\"") ?? "";
        if (string.IsNullOrWhiteSpace(text))
        {
            var page = await v.RunScriptAsync("(document.querySelector('article')||document.body).innerText.slice(0,20000)");
            text = JsonSerializer.Deserialize<string>(page ?? "\"\"") ?? "";
        }
        if (string.IsNullOrWhiteSpace(text)) { ShowToast("There's no text to read on this page."); return; }
        Speech.Speak(text);
        ShowToast("Reading aloud… use “Stop reading” in the command bar (Ctrl+K) to stop.");
    }
}
