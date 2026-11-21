using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace WIISBROWSING.App.Views;

/// <summary>Small themed dialogs (confirm, input, choice). Built in code so they always follow the current theme.</summary>
public static class Dialogs
{
    private static Window Build(Window owner, string title, UIElement body, double width = 420)
    {
        var win = new Window
        {
            Owner = owner, WindowStartupLocation = WindowStartupLocation.CenterOwner, WindowStyle = WindowStyle.None, AllowsTransparency = true,
            Background = Brushes.Transparent, ShowInTaskbar = false, SizeToContent = SizeToContent.Height, Width = width + 48, ResizeMode = ResizeMode.NoResize, Title = title,
        };
        win.SetResourceReference(Control.FontFamilyProperty, "UiFontFamily");
        win.FontSize = 13;
        var card = new Border { Margin = new Thickness(24), Padding = new Thickness(22), CornerRadius = new CornerRadius(14), BorderThickness = new Thickness(1), Child = body };
        card.SetResourceReference(Border.BackgroundProperty, "SurfaceElevatedBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "BorderSubtleBrush");
        card.SetResourceReference(UIElement.EffectProperty, "PanelShadow");
        win.Content = card;
        win.PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { win.DialogResult = false; e.Handled = true; } };
        return win;
    }

    private static TextBlock Heading(string text)
    {
        var t = new TextBlock { Text = text, FontSize = 17, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8), TextWrapping = TextWrapping.Wrap };
        t.SetResourceReference(TextBlock.ForegroundProperty, "TextPrimaryBrush");
        return t;
    }

    private static TextBlock Body(string text)
    {
        var t = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, LineHeight = 20, Margin = new Thickness(0, 0, 0, 16) };
        t.SetResourceReference(TextBlock.ForegroundProperty, "TextMutedBrush");
        return t;
    }

    private static Button Btn(string text, bool accent, Action click)
    {
        var b = new Button { Content = text, Margin = new Thickness(8, 0, 0, 0), MinWidth = 88 };
        b.SetResourceReference(FrameworkElement.StyleProperty, accent ? "AccentButton" : "PillButton");
        b.Click += (_, _) => click();
        return b;
    }

    public static bool Confirm(Window owner, string title, string message, string ok = "OK", string cancel = "Cancel")
    {
        var panel = new StackPanel();
        panel.Children.Add(Heading(title));
        panel.Children.Add(Body(message));
        Window win = null!;
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        row.Children.Add(Btn(cancel, false, () => win.DialogResult = false));
        var okBtn = Btn(ok, true, () => win.DialogResult = true);
        okBtn.IsDefault = true;
        row.Children.Add(okBtn);
        panel.Children.Add(row);
        win = Build(owner, title, panel);
        return win.ShowDialog() == true;
    }

    public static void Message(Window owner, string title, string message)
    {
        var panel = new StackPanel();
        panel.Children.Add(Heading(title));
        panel.Children.Add(Body(message));
        Window win = null!;
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var ok = Btn("OK", true, () => win.DialogResult = true);
        ok.IsDefault = true;
        row.Children.Add(ok);
        panel.Children.Add(row);
        win = Build(owner, title, panel);
        win.ShowDialog();
    }

    /// <summary>Returns the text, or null if cancelled.</summary>
    public static string? Input(Window owner, string title, string label, string initial = "", int maxLength = 200)
    {
        var panel = new StackPanel();
        panel.Children.Add(Heading(title));
        panel.Children.Add(Body(label));
        var box = new TextBox { Text = initial, MaxLength = maxLength, Margin = new Thickness(0, 0, 0, 16) };
        box.SetResourceReference(FrameworkElement.StyleProperty, "BoxedTextBox");
        panel.Children.Add(box);
        Window win = null!;
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        row.Children.Add(Btn("Cancel", false, () => win.DialogResult = false));
        var ok = Btn("OK", true, () => win.DialogResult = true);
        ok.IsDefault = true;
        row.Children.Add(ok);
        panel.Children.Add(row);
        win = Build(owner, title, panel);
        win.Loaded += (_, _) => { box.Focus(); box.SelectAll(); };
        return win.ShowDialog() == true ? box.Text : null;
    }

    /// <summary>Returns the index of the chosen button, or -1 if the dialog was dismissed. The last option is treated as Cancel.</summary>
    public static int Choose(Window owner, string title, string message, string[] options)
    {
        var panel = new StackPanel();
        panel.Children.Add(Heading(title));
        panel.Children.Add(Body(message));
        int result = -1;
        Window win = null!;
        var row = new StackPanel { Orientation = Orientation.Vertical };
        for (int i = 0; i < options.Length; i++)
        {
            int idx = i;
            var b = Btn(options[i], i == 0, () => { result = idx; win.DialogResult = true; });
            b.Margin = new Thickness(0, 4, 0, 0);
            b.HorizontalAlignment = HorizontalAlignment.Stretch;
            row.Children.Add(b);
        }
        panel.Children.Add(row);
        win = Build(owner, title, panel);
        win.ShowDialog();
        return result == options.Length - 1 ? -1 : result;
    }
}
