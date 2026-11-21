using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace WIISBROWSING.App.Views;

public sealed record PaletteItem(string Title, string Subtitle, string Glyph, string Hint, Action Run);

/// <summary>
/// The floating command bar (Ctrl+K) and tab search. It's its own window so it floats above the web page;
/// results come from a provider function, so the same window serves commands, tabs and moves.
/// </summary>
public sealed class PaletteWindow : Window
{
    private readonly TextBox _input;
    private readonly ListBox _list;
    private readonly Func<string, IReadOnlyList<PaletteItem>> _provider;
    private readonly Window _owner;
    private bool _closing;

    public static void Show(Window owner, string placeholder, Func<string, IReadOnlyList<PaletteItem>> provider, string initial = "")
    {
        var w = new PaletteWindow(owner, placeholder, provider, initial);
        w.Show();
    }

    private PaletteWindow(Window owner, string placeholder, Func<string, IReadOnlyList<PaletteItem>> provider, string initial)
    {
        _owner = owner;
        _provider = provider;
        Owner = owner;
        WindowStyle = WindowStyle.None; AllowsTransparency = true; Background = Brushes.Transparent; ShowInTaskbar = false;
        ResizeMode = ResizeMode.NoResize; SizeToContent = SizeToContent.Height; Width = 700; ShowActivated = true;
        this.SetResourceReference(FontFamilyProperty, "UiFontFamily");
        FontSize = 14;

        _input = new TextBox { Text = initial, FontSize = 17, Margin = new Thickness(18, 0, 18, 0), VerticalContentAlignment = VerticalAlignment.Center };
        _input.SetResourceReference(StyleProperty, "FlatTextBox");
        var hint = new TextBlock { Text = placeholder, FontSize = 17, Margin = new Thickness(20, 0, 0, 0), IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Center };
        hint.SetResourceReference(TextBlock.ForegroundProperty, "TextMutedBrush");
        var inputHost = new Grid { Height = 56 };
        inputHost.Children.Add(hint);
        inputHost.Children.Add(_input);

        _list = new ListBox { MaxHeight = 440, Margin = new Thickness(6, 0, 6, 8), Focusable = false };
        _list.SetResourceReference(StyleProperty, "PlainList");
        var sep = new Border { Height = 1 };
        sep.SetResourceReference(Border.BackgroundProperty, "BorderSubtleBrush");

        var stack = new StackPanel();
        stack.Children.Add(inputHost);
        stack.Children.Add(sep);
        stack.Children.Add(_list);

        var card = new Border { Margin = new Thickness(22), CornerRadius = new CornerRadius(16), BorderThickness = new Thickness(1), Child = stack };
        card.SetResourceReference(Border.BackgroundProperty, "SurfaceElevatedBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "BorderSubtleBrush");
        card.SetResourceReference(UIElement.EffectProperty, "PanelShadow");
        Content = card;

        Loaded += (_, _) =>
        {
            Left = owner.Left + (owner.ActualWidth - ActualWidth) / 2;
            Top = owner.Top + Math.Max(40, owner.ActualHeight * 0.14);
            _input.Focus();
            _input.CaretIndex = _input.Text.Length;
            Refresh();
        };
        _input.TextChanged += (_, _) => { hint.Visibility = _input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed; Refresh(); };
        PreviewKeyDown += OnKey;
        Deactivated += (_, _) => CloseSafely();
        _list.PreviewMouseLeftButtonUp += (_, e) =>
        {
            if (e.OriginalSource is DependencyObject d && ItemOf(d) is { Tag: PaletteItem it }) { Run(it); e.Handled = true; }
        };
    }

    private static ListBoxItem? ItemOf(DependencyObject d)
    {
        while (d is not null && d is not ListBoxItem) d = VisualTreeHelper.GetParent(d);
        return d as ListBoxItem;
    }

    private void Refresh()
    {
        _list.Items.Clear();
        IReadOnlyList<PaletteItem> items;
        try { items = _provider(_input.Text); }
        catch (Exception ex) { Core.Util.AppLog.Error("palette provider", ex); items = Array.Empty<PaletteItem>(); }
        foreach (var it in items)
        {
            var row = new Grid { Height = 48, Background = Brushes.Transparent };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var glyph = new TextBlock { Text = it.Glyph, FontSize = 15, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            glyph.SetResourceReference(TextBlock.FontFamilyProperty, "IconFont");
            glyph.SetResourceReference(TextBlock.ForegroundProperty, "AccentSecondaryBrush");
            var texts = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            var title = new TextBlock { Text = it.Title, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 14 };
            title.SetResourceReference(TextBlock.ForegroundProperty, "TextPrimaryBrush");
            texts.Children.Add(title);
            if (!string.IsNullOrEmpty(it.Subtitle))
            {
                var sub = new TextBlock { Text = it.Subtitle, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 11.5 };
                sub.SetResourceReference(TextBlock.ForegroundProperty, "TextMutedBrush");
                texts.Children.Add(sub);
            }
            Grid.SetColumn(texts, 1);
            row.Children.Add(glyph);
            row.Children.Add(texts);
            if (!string.IsNullOrEmpty(it.Hint))
            {
                var key = new Border { CornerRadius = new CornerRadius(5), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(8, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
                key.SetResourceReference(Border.BackgroundProperty, "HoverBrush");
                var kt = new TextBlock { Text = it.Hint, FontSize = 11.5 };
                kt.SetResourceReference(TextBlock.ForegroundProperty, "TextMutedBrush");
                key.Child = kt;
                Grid.SetColumn(key, 2);
                row.Children.Add(key);
            }
            var lbi = new ListBoxItem { Content = row, Tag = it, Padding = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 1, 0, 1) };
            lbi.Template = ItemTemplate();
            _list.Items.Add(lbi);
        }
        if (_list.Items.Count > 0) _list.SelectedIndex = 0;
    }

    private static ControlTemplate ItemTemplate()
    {
        const string xaml = "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ListBoxItem'>" +
            "<Border x:Name='b' CornerRadius='10' Background='Transparent'><ContentPresenter/></Border>" +
            "<ControlTemplate.Triggers><Trigger Property='IsSelected' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource HoverBrush}'/></Trigger>" +
            "<Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource HoverBrush}'/></Trigger></ControlTemplate.Triggers></ControlTemplate>";
        return (ControlTemplate)System.Windows.Markup.XamlReader.Parse(xaml);
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Escape: CloseSafely(); e.Handled = true; break;
            case Key.Down: Move(1); e.Handled = true; break;
            case Key.Up: Move(-1); e.Handled = true; break;
            case Key.Enter:
                if (_list.SelectedItem is ListBoxItem { Tag: PaletteItem it }) Run(it);
                e.Handled = true; break;
        }
    }

    private void Move(int delta)
    {
        if (_list.Items.Count == 0) return;
        _list.SelectedIndex = Math.Clamp(_list.SelectedIndex + delta, 0, _list.Items.Count - 1);
        _list.ScrollIntoView(_list.SelectedItem);
    }

    private void Run(PaletteItem item)
    {
        CloseSafely();
        _owner.Dispatcher.BeginInvoke(() =>
        {
            try { item.Run(); }
            catch (Exception ex) { Core.Util.AppLog.Error("palette action", ex); }
        }, DispatcherPriority.Input);
    }

    private void CloseSafely()
    {
        if (_closing) return;
        _closing = true;
        try { Close(); } catch (InvalidOperationException) { }
    }
}
