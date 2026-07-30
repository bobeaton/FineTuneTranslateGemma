using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using ECInterfaces;
using Newtonsoft.Json;
using SilEncConverters40;

namespace EncConverterCompare
{
    /// <summary>One paragraph run through both converters via IEncConverter.Convert
    /// (so each converter's own internal sentence-splitting/chunking applies exactly
    /// as it would in real use -- we never split sentences ourselves).</summary>
    public class ComparisonResult
    {
        public int Index;
        public string Source;
        public string NllbOutput;
        public double NllbMs;
        public string NllbError;
        public string TgOutput;
        public double TgMs;
        public string TgError;
    }

    internal class Program
    {
        private const string NllbConverterName = "NLLB-studies Translate Hindi to Kangri";
        private const string TgConverterName = "TranslateGemma-studies Translate Hindi to Kangri";

        private static int Main(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: EncConverterCompare.exe <sourceTextFile> <outputJsonFile>");
                return 1;
            }
            string sourcePath = args[0];
            string outputPath = args[1];

            Console.OutputEncoding = Encoding.UTF8;

            var encConverters = new EncConverters();

            var nllb = encConverters[NllbConverterName];
            var tg = encConverters[TgConverterName];

            if (nllb == null)
            {
                Console.Error.WriteLine($"Converter not found in repository: {NllbConverterName}");
                return 2;
            }
            if (tg == null)
            {
                Console.Error.WriteLine($"Converter not found in repository: {TgConverterName}");
                return 2;
            }

            Console.WriteLine($"NLLB converter:           {nllb.ConverterIdentifier}");
            Console.WriteLine($"TranslateGemma converter: {tg.ConverterIdentifier}");

            var paragraphs = ExtractParagraphs(sourcePath);
            Console.WriteLine($"Extracted {paragraphs.Count} paragraphs from {Path.GetFileName(sourcePath)}");

            var results = new List<ComparisonResult>();
            var sw = new Stopwatch();

            for (int i = 0; i < paragraphs.Count; i++)
            {
                string text = paragraphs[i];
                var result = new ComparisonResult { Index = i, Source = text };

                Console.WriteLine($"[{i + 1}/{paragraphs.Count}] ({text.Length} chars) translating with NLLB...");
                try
                {
                    sw.Restart();
                    result.NllbOutput = nllb.Convert(text);
                    sw.Stop();
                    result.NllbMs = sw.Elapsed.TotalMilliseconds;
                }
                catch (Exception ex)
                {
                    result.NllbError = ex.Message;
                    Console.Error.WriteLine($"  NLLB error: {ex.Message}");
                }

                Console.WriteLine($"[{i + 1}/{paragraphs.Count}] ({text.Length} chars) translating with TranslateGemma...");
                try
                {
                    sw.Restart();
                    result.TgOutput = tg.Convert(text);
                    sw.Stop();
                    result.TgMs = sw.Elapsed.TotalMilliseconds;
                }
                catch (Exception ex)
                {
                    result.TgError = ex.Message;
                    Console.Error.WriteLine($"  TranslateGemma error: {ex.Message}");
                }

                results.Add(result);

                // flush progress to disk after every paragraph, so a crash or timeout
                // partway through doesn't lose already-completed translations
                WriteJson(outputPath, results);
            }

            int differing = results.Count(r => r.NllbOutput != r.TgOutput);
            var nllbTimes = results.Where(r => r.NllbError == null).Select(r => r.NllbMs).ToList();
            var tgTimes = results.Where(r => r.TgError == null).Select(r => r.TgMs).ToList();

            Console.WriteLine();
            Console.WriteLine($"Done. {results.Count} paragraphs, {differing} with differing output.");
            if (nllbTimes.Count > 0)
                Console.WriteLine($"NLLB avg:           {nllbTimes.Average():F0} ms  (total {nllbTimes.Sum() / 1000:F1} s over {nllbTimes.Count} calls)");
            if (tgTimes.Count > 0)
                Console.WriteLine($"TranslateGemma avg: {tgTimes.Average():F0} ms  (total {tgTimes.Sum() / 1000:F1} s over {tgTimes.Count} calls)");
            Console.WriteLine($"Results written to {outputPath}");

            return 0;
        }

        private static void WriteJson(string path, List<ComparisonResult> results)
        {
            string json = JsonConvert.SerializeObject(results, Formatting.Indented);
            File.WriteAllText(path, json, new UTF8Encoding(false));
        }

        /// <summary>Splits the source file into paragraphs on blank lines, trimming the
        /// leading-whitespace-per-line formatting these study scripts are saved with.
        /// Deliberately does NOT split sentences -- that's the EncConverter's job.</summary>
        private static List<string> ExtractParagraphs(string path)
        {
            var lines = File.ReadAllLines(path, Encoding.UTF8);
            var paragraphs = new List<string>();
            var current = new List<string>();

            void FlushCurrent()
            {
                if (current.Count > 0)
                {
                    string joined = string.Join(" ", current).Trim();
                    if (joined.Length > 0)
                        paragraphs.Add(joined);
                    current.Clear();
                }
            }

            foreach (var rawLine in lines)
            {
                string line = rawLine.Trim();
                if (line.Length == 0)
                {
                    FlushCurrent();
                }
                else
                {
                    current.Add(line);
                }
            }
            FlushCurrent();

            return paragraphs;
        }
    }
}
