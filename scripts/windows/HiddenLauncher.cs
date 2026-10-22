using System;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;

// GUI-subsystem entrypoint for non-interactive scheduled jobs. It does not
// create a console, invoke a command shell, change arguments, or detach early.
internal static class HiddenLauncher {
    public sealed class LaunchConfig {
        public string FilePath { get; set; }
        public string Arguments { get; set; }
        public string WorkingDirectory { get; set; }
    }
    private static int Main(string[] args) {
        if (args.Length != 1) return 64;
        string configPath = args[0];
        try {
            configPath = Path.GetFullPath(configPath);
            var config = new JavaScriptSerializer().Deserialize<LaunchConfig>(File.ReadAllText(configPath));
            if (config == null || !Path.IsPathRooted(config.FilePath) || !File.Exists(config.FilePath))
                throw new InvalidOperationException("The configured executable must be an existing absolute path.");
            var start = new ProcessStartInfo(config.FilePath, config.Arguments ?? "") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            };
            if (!String.IsNullOrEmpty(config.WorkingDirectory)) start.WorkingDirectory = config.WorkingDirectory;
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch (Exception error) {
            try {
                File.AppendAllText(configPath + ".error.log", DateTime.UtcNow.ToString("o") + " " + error.Message + Environment.NewLine);
            } catch { /* Still report failure if the configuration directory is unwritable. */ }
            return 1;
        }
    }
}
