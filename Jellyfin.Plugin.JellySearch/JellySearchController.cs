using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellySearch;

/// <summary>
/// Serves the injected web assets.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("JellySearch")]
public class JellySearchController : ControllerBase
{
    private static readonly Assembly PluginAssembly = typeof(JellySearchController).Assembly;

    /// <summary>
    /// Gets the JavaScript asset.
    /// </summary>
    /// <returns>The JavaScript file.</returns>
    [HttpGet("filters.js")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult GetScript()
    {
        return ServeResource("filters.js", "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Gets the stylesheet asset.
    /// </summary>
    /// <returns>The CSS file.</returns>
    [HttpGet("filters.css")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult GetStylesheet()
    {
        return ServeResource("filters.css", "text/css; charset=utf-8");
    }

    private IActionResult ServeResource(string fileName, string contentType)
    {
        var resourceName = string.Format(
            System.Globalization.CultureInfo.InvariantCulture,
            "{0}.Web.{1}",
            typeof(Plugin).Namespace,
            fileName);

        var stream = PluginAssembly.GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            return NotFound();
        }

        return File(stream, contentType);
    }
}
