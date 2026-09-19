using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.JellySearch;

/// <summary>
/// Adds the index.html injection middleware at the start of the request pipeline.
/// </summary>
public class WebInjectionStartupFilter : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<IndexHtmlInjectionMiddleware>();
            next(app);
        };
    }
}
