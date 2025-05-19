# Audyssey One Evo Acoustica quick guide for macOS

By Chris Bope
Version 1.1 for Audyssey One Evo Acoustica 4.x by OCA

## Introduction

If this is your first time using Evo Acoustica, it is strongly recommended to start with the default settings and listen to the results first before changing any settings. If the results are not as desired, you can re-run Evo Acoustica with different settings.

## Measurements

Evo Acoustica does not yet support making measurements, so you will need to use one of the following methods to make measurements before you can use Evo Acoustica:

1.  Use an existing pre-processed `.mdat` file created using an earlier release such as Evo Neuron.
2.  Use an existing or create a new `.ady` file using the MultEQ Editor mobile app. If you create a new `.ady` file using the mobile app, you will need to transfer the file from your mobile device to your Mac so it can be used with Evo Acoustica. Save the file in your `Downloads` folder.
3.  Use an existing `.ady` measurements file created using `odd.wtf` from an earlier release (such as Evo Neuron).
4.  Use REW with manual sweeps and a UMIK or other supported measurement microphone. This method will be covered in a separate quick guide.

## Initial setup of Evo Acoustica

1.  Download the latest Evo Acoustica release from the official Google Drive link:
    [https://drive.google.com/drive/folders/1O-KcP9jfBYZePW9IGPE2sbqrx_x96Vrr](https://drive.google.com/drive/folders/1O-KcP9jfBYZePW9IGPE2sbqrx_x96Vrr)

2.  The following files are required, save both files to your `Downloads` folder:
    a.  `a1-evo-acoustica-macos_v4.4.2.zip` (or a newer version)
    b.  A target curve from the **Target curve library** folder. If you're not sure which target curve to use, start with the **Evo Acoustica** target. Note that the selected target curve will affect overall frequency response, primarily the bass and high frequency rolloff. You can compare the various target curves by downloading and opening the `Compare Target Curves.mdat` file in REW, from the Target Curve Library folder.

3.  Open Finder and navigate to your `Downloads` folder where you saved the downloaded files.

4.  Double-click the file `a1-evo-acoustica-macos_v4.4.2.zip` to extract the contents. A new sub-folder will be created named `a1-evo-acoustica-macos_v4.4.2` which contains the extracted files.

5.  There will be 2 files, the file ending in `x64` is used for Intel processor Macs and the file ending in `arm` is for newer Macs with M-series processors. You must use the correct file based on the CPU in your Mac.

6.  Copy or drag the appropriate `x64` or `arm` file to your `Downloads` folder.

7.  Now we need to make the `x64` or `arm` file executable so macOS will allow you to run it.
    **NOTE:** The following steps are only needed the first time you use the `x64` or `arm` file. You can skip these steps when running the same version of Evo Acoustica in the future.
    a.  Press **CMD+space** and type `terminal` into Spotlight Search. Press **Enter** to open the Terminal app.
    b.  In Terminal, type `cd ~/Downloads` and press **Enter**.
        i.  If you're using the `x64` version, type `xattr -c a1-evo-acoustica-macos-x64` and press **Enter**. Then type `chmod +x a1-evo-acoustica-macos-x64` and press **Enter**.
        ii. If you're using the `arm` version, type `xattr -c a1-evo-acoustica-macos-arm` and press **Enter**. Then type `chmod +x a1-evo-acoustica-macos-arm` and press **Enter**.

8.  Download and install the MacOS version of REW beta 78 or newer (Evo Acoustica 4.4 is not compatible with earlier versions): [https://www.avnirvana.com/threads/rew-api-beta-releases.12981/](https://www.avnirvana.com/threads/rew-api-beta-releases.12981/)

9.  In REW, click the **Preferences** button and perform the following:
    a.  On the **View** tab, set **Maximum measurements** to `1000`.
    b.  On the **Equaliser** tab, un-check **Drop filters if gain is small**.
    **Note:** You only need to make these settings once after installing REW.
    c.  Close REW and re-open it for the new settings to be applied.

10. In REW, click **Preferences** again, and on the **API** tab click **Start server**. Close the Preferences window.

11. Click the **EQ** button and expand **Target settings**. Target type should be **None**.

12. Under **House curve**, click the **folder** button and select the target curve you downloaded in step 2b from your `Downloads` folder. Close the EQ window.

## Method 1: Running Evo Acoustica with an existing pre-processed measurement .mdat file

1.  In Finder, navigate to your `Downloads` folder and double-click the file `a1-evo-acoustica-macos-x64` or `a1-evo-acoustica-macos-arm` file to open the Evo Acoustica menu in a terminal window.
2.  Select option **1. Discover AVR & Create Configuration File** and press Enter to create the configuration file. A list of discovered devices will be shown, select your AVR and press Enter.
3.  Next, select option **2. Start Optimization**. Evo Acoustica will open in your default web browser.
4.  In REW, click the **Open** button and select your existing pre-processed measurements `.mdat` file.
5.  Back to Evo Acoustica in your browser. Select the desired settings and click the **START OPTIMIZATION...** button at the bottom.
6.  It will take a few minutes for Evo Acoustica to run. The resulting `.oca` calibration file and log file in HTML format will be automatically saved in your `Downloads` folder.
7.  Back to the Evo Acoustica menu in the terminal window, select **3. Transfer Optimized Calibration** and press Enter.
8.  The most recent `.oca` calibration file will be automatically selected, if more than one calibration file exists. Press Enter to send the most recent calibration file.
9.  If your AVR supports multiple speaker presets, you will be prompted to choose which preset to store the new calibration to. Pressing Enter will store it to the currently active preset. You can also choose to store the new calibration to the non-active preset.
10. That's it, you're done!

## Method 2 or 3: Running Evo Acoustica with an existing .ady file

1.  You can use an existing `.ady` file created using the MultEQ Editor mobile app or `odd.wtf` from a previous release. The process is the same for both.
2.  In your `Downloads` folder in Finder, double-click the file `a1-evo-acoustica-macos-x64` or `a1-evo-acoustica-macos-arm` file to open the Evo Acoustica menu in a terminal window.
3.  Select option **1. Discover AVR & Create Configuration File** and press Enter to create the configuration file. A list of discovered devices will be shown, select your AVR and press Enter.
4.  Next, select option **2. Start Optimization**. Evo Acoustica will open in your default web browser.
5.  Click the button **EXTRACT CALIBRATION MEASUREMENTS...** then browse to the folder where your `.ady` or `.mqx` file is saved and open it. The measurements will be loaded into REW. It will take a moment for REW to process the measurements. When you see the speaker response graph appear on the **SPL & Phase** tab, REW is ready.
6.  In Finder, open the zip file by double-clicking it, then press **CMD+A** to select all files and drag the files into the REW window.
7.  It will take a moment for REW to process the measurements. When you see the speaker response graph appear on the **SPL & Phase** tab, REW is ready.
8.  Back to Evo Acoustica in your browser. Select the desired settings and click the **START OPTIMIZATION...** button at the bottom.
    **NOTE:** Once Evo Acoustica has processed your extracted measurements in REW, you will be prompted to save the pre-processed measurements as an `.mdat` file. If you want to run Evo Acoustica again you can use Method 1 with the `.mdat` file and this will significantly speed up running it again.
9.  It will take a few minutes for Evo Acoustica to run. The resulting `.oca` calibration file and log file in HTML format will automatically be saved in your `Downloads` folder.
10. Back to the Evo Acoustica menu in the terminal window, select **3. Transfer Optimized Calibration** and press Enter.
11. The most recent `.oca` calibration file will be automatically selected, if more than one calibration file exists. Press Enter to send the most recent calibration file.
12. If your AVR supports multiple speaker presets, you will be prompted to choose which preset to store the new calibration to. Pressing Enter will store it to the currently active preset. You can also choose to store the new calibration to the non-active preset.
13. That's it, you're done!

---

## Enjoy your Audyssey One Evo Acoustica sound!

Be sure to visit OCA's YouTube channel and watch the Evo Acoustica video:
[https://youtu.be/wQHF0-MOMMY?si=1E_-TFR1QfAmJ6WR](https://youtu.be/wQHF0-MOMMY?si=1E_-TFR1QfAmJ6WR)
