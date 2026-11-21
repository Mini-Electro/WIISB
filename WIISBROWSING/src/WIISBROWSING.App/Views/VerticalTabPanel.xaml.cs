using System.Windows;
using System.Windows.Controls;

namespace WIISBROWSING.App.Views;

/// <summary>The vertical tab list. One instance is moved between the left and right slots, so changing the layout never touches the tabs.</summary>
public partial class VerticalTabPanel : UserControl
{
    public event Action? NewTabRequested;
    public event Action? SearchRequested;
    public event Action? ClusterMenuRequested;
    public event Action? CollapseRequested;

    public VerticalTabPanel() => InitializeComponent();

    public ListBox Rows => RowsList;
    public ItemsControl Pinned => PinnedList;

    /// <summary>Compact rail: favicons only. The same list, just narrower.</summary>
    public void SetCompact(bool compact)
    {
        HeaderTitle.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        SearchBtn.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        ClusterBtn.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        NewTabLabel.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        CollapseBtn.Content = compact ? "" : "";
        CollapseBtn.ToolTip = compact ? "Expand tab panel" : "Collapse tab panel";
        Header.Margin = compact ? new Thickness(0) : new Thickness(0);
    }

    public void SetWorkspace(string icon, string name)
    {
        WsIcon.Text = icon;
        WsName.Text = name;
    }

    private void NewTab_Click(object sender, RoutedEventArgs e) => NewTabRequested?.Invoke();
    private void Search_Click(object sender, RoutedEventArgs e) => SearchRequested?.Invoke();
    private void Cluster_Click(object sender, RoutedEventArgs e) => ClusterMenuRequested?.Invoke();
    private void Collapse_Click(object sender, RoutedEventArgs e) => CollapseRequested?.Invoke();
}
