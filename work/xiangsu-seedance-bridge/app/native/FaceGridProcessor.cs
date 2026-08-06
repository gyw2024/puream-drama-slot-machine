using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.FaceAnalysis;
using Windows.Storage;
using Windows.Storage.Streams;

namespace PureamDramaSlot
{
    internal static class FaceGridProcessor
    {
        private sealed class FaceRegion
        {
            public double X;
            public double Y;
            public double Width;
            public double Height;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length != 2) return Fail("FACE_GRID_ARGUMENTS_INVALID", "Expected input and output paths.", 2);
                return RunAsync(Path.GetFullPath(args[0]), Path.GetFullPath(args[1])).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                return Fail("FACE_GRID_PROCESSOR_FAILED", error.Message, 1);
            }
        }

        private static async Task<int> RunAsync(string inputPath, string outputPath)
        {
            if (!File.Exists(inputPath)) return Fail("FACE_GRID_SOURCE_MISSING", "Input image does not exist.", 2);
            IList<DetectedFace> detected;
            int detectedWidth;
            int detectedHeight;
            StorageFile input = await StorageFile.GetFileFromPathAsync(inputPath);
            using (IRandomAccessStream stream = await input.OpenAsync(FileAccessMode.Read))
            {
                BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
                using (SoftwareBitmap decodedBitmap = await decoder.GetSoftwareBitmapAsync())
                using (SoftwareBitmap softwareBitmap = SoftwareBitmap.Convert(decodedBitmap, BitmapPixelFormat.Gray8, BitmapAlphaMode.Ignore))
                {
                    detectedWidth = softwareBitmap.PixelWidth;
                    detectedHeight = softwareBitmap.PixelHeight;
                    FaceDetector detector = await FaceDetector.CreateAsync();
                    detected = await detector.DetectFacesAsync(softwareBitmap);
                }
            }
            if (detected == null || detected.Count == 0) return Fail("FACE_NOT_DETECTED", "No face was detected; no grid image was saved.", 3);

            List<FaceRegion> regions = new List<FaceRegion>();
            using (Bitmap source = new Bitmap(inputPath))
            using (Bitmap output = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(output))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.DrawImage(source, 0, 0, source.Width, source.Height);
                graphics.CompositingMode = CompositingMode.SourceOver;
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                double scaleX = source.Width / (double)Math.Max(1, detectedWidth);
                double scaleY = source.Height / (double)Math.Max(1, detectedHeight);
                float lineWidth = Math.Max(0.75f, Math.Min(source.Width, source.Height) / 900f);
                using (Pen pen = new Pen(Color.FromArgb(112, 53, 215, 229), lineWidth))
                {
                    int faceLimit = Math.Min(detected.Count, 9);
                    for (int index = 0; index < faceLimit; index++)
                    {
                        DetectedFace face = detected[index];
                        double x = face.FaceBox.X * scaleX;
                        double y = face.FaceBox.Y * scaleY;
                        double width = face.FaceBox.Width * scaleX;
                        double height = face.FaceBox.Height * scaleY;
                        double left = Math.Max(0, x - width * 0.45);
                        double top = Math.Max(0, y - height * 0.70);
                        double right = Math.Min(source.Width, x + width * 1.45);
                        double bottom = Math.Min(source.Height, y + height * 1.55);
                        double regionWidth = right - left;
                        double regionHeight = bottom - top;
                        if (regionWidth < 12 || regionHeight < 12) continue;
                        double cell = Math.Max(4, Math.Min(regionWidth, regionHeight) / 18.0);
                        for (double lineX = left; lineX <= right + 0.25; lineX += cell)
                            graphics.DrawLine(pen, (float)lineX, (float)top, (float)lineX, (float)bottom);
                        for (double lineY = top; lineY <= bottom + 0.25; lineY += cell)
                            graphics.DrawLine(pen, (float)left, (float)lineY, (float)right, (float)lineY);
                        regions.Add(new FaceRegion { X = left, Y = top, Width = regionWidth, Height = regionHeight });
                    }
                }
                if (regions.Count == 0) return Fail("FACE_NOT_DETECTED", "No usable face was detected; no grid image was saved.", 3);
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                output.Save(outputPath, ImageFormat.Png);
            }
            Console.Out.WriteLine(SuccessJson(outputPath, detectedWidth, detectedHeight, regions));
            return 0;
        }

        private static string SuccessJson(string outputPath, int width, int height, IList<FaceRegion> regions)
        {
            StringBuilder boxes = new StringBuilder();
            for (int i = 0; i < regions.Count; i++)
            {
                if (i > 0) boxes.Append(',');
                FaceRegion region = regions[i];
                boxes.Append("{\"x\":").Append(region.X.ToString("0.##", CultureInfo.InvariantCulture))
                    .Append(",\"y\":").Append(region.Y.ToString("0.##", CultureInfo.InvariantCulture))
                    .Append(",\"width\":").Append(region.Width.ToString("0.##", CultureInfo.InvariantCulture))
                    .Append(",\"height\":").Append(region.Height.ToString("0.##", CultureInfo.InvariantCulture)).Append('}');
            }
            return "{\"ok\":true,\"faceCount\":" + regions.Count + ",\"width\":" + width + ",\"height\":" + height
                + ",\"outputPath\":\"" + Escape(outputPath) + "\",\"regions\":[" + boxes + "]}";
        }

        private static int Fail(string code, string message, int exitCode)
        {
            Console.Error.WriteLine("{\"ok\":false,\"code\":\"" + Escape(code) + "\",\"message\":\"" + Escape(message) + "\"}");
            return exitCode;
        }

        private static string Escape(string value)
        {
            return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }
    }
}
