using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellySearch;

/// <summary>
/// Registers plugin services with the Jellyfin service collection.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Registers an ASP.NET Core startup filter so the middleware that injects
        // the web assets is added to the front of the request pipeline.
        serviceCollection.AddTransient<IStartupFilter, WebInjectionStartupFilter>();
    }
}
