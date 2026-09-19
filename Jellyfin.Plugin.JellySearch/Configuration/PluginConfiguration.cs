using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellySearch.Configuration;

/// <summary>
/// Plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether the web client injection is enabled.
    /// </summary>
    public bool EnableInjection { get; set; } = true;

    /// <summary>
    /// Gets or sets the number of years to keep as the initial slider window.
    /// </summary>
    public int DefaultRangeYears { get; set; } = 10;
}
