using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellySearch;

/// <summary>
/// Rewrites the served jellyfin-web <c>index.html</c> in memory and injects the
/// JellySearch CSS and JavaScript assets. No files on disk are modified.
/// </summary>
public class IndexHtmlInjectionMiddleware
{
    private const string Marker = "data-jellysearch";
    private const string BodyEndTag = "</body>";
    private const string ReactRootMarker = "reactRoot";

    // Changes whenever the plugin assembly is rebuilt, so clients always fetch
    // the matching asset version instead of a stale cached copy.
    private static readonly string VersionToken = ComputeVersionToken();

    private readonly RequestDelegate _next;

    /// <summary>
    /// Initializes a new instance of the <see cref="IndexHtmlInjectionMiddleware"/> class.
    /// </summary>
    /// <param name="next">The next request delegate.</param>
    public IndexHtmlInjectionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    /// <summary>
    /// Processes a request.
    /// </summary>
    /// <param name="context">The current <see cref="HttpContext"/>.</param>
    /// <returns>A task that represents the asynchronous operation.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null || !config.EnableInjection || !ShouldProcess(context))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;

        // Force a fresh response and disable compression so the HTML can be rewritten safely.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        try
        {
            await _next(context).ConfigureAwait(false);

            var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
                && context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) == true;

            if (isHtml)
            {
                buffer.Seek(0, SeekOrigin.Begin);
                using var reader = new StreamReader(buffer, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                var html = await reader.ReadToEndAsync().ConfigureAwait(false);

                if (html.Contains(ReactRootMarker, StringComparison.Ordinal)
                    && !html.Contains(Marker, StringComparison.Ordinal)
                    && html.Contains(BodyEndTag, StringComparison.OrdinalIgnoreCase))
                {
                    html = Inject(html);
                    var bytes = Encoding.UTF8.GetBytes(html);
                    context.Response.Headers.Remove("Content-Encoding");
                    context.Response.Headers.Remove("ETag");
                    context.Response.Headers.Remove("Last-Modified");
                    context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
                    context.Response.ContentLength = bytes.Length;
                    await originalBody.WriteAsync(bytes).ConfigureAwait(false);
                    return;
                }
            }

            buffer.Seek(0, SeekOrigin.Begin);
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBody;
        }
    }

    private static bool ShouldProcess(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method))
        {
            return false;
        }

        // Only the web client document needs to be rewritten. Restricting this to the
        // index document avoids buffering API responses (the Jellyfin SDK sends an
        // Accept header that also contains "text/html").
        var path = context.Request.Path.Value?.TrimEnd('/') ?? string.Empty;
        return path.Length == 0
            || path.EndsWith("/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web", StringComparison.OrdinalIgnoreCase);
    }

    private static string Inject(string html)
    {
        var snippet =
            "<link rel=\"stylesheet\" href=\"../JellySearch/filters.css?v=" + VersionToken + "\" " + Marker + ">\n" +
            "<script src=\"../JellySearch/filters.js?v=" + VersionToken + "\" " + Marker + "></script>\n";

        var index = html.LastIndexOf(BodyEndTag, StringComparison.OrdinalIgnoreCase);
        return index < 0 ? html : html.Insert(index, snippet);
    }

    private static string ComputeVersionToken()
    {
        try
        {
            var location = typeof(Plugin).Assembly.Location;
            if (!string.IsNullOrEmpty(location) && File.Exists(location))
            {
                return File.GetLastWriteTimeUtc(location).Ticks.ToString(CultureInfo.InvariantCulture);
            }
        }
        catch (IOException)
        {
            // Fall back to the assembly version below.
        }

        return typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "1";
    }
}
