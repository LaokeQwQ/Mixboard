# Mixboard

Mixboard is a lightweight, real-time web dashboard for Denon DJ Prime/Engine OS hardware. It connects to DJ devices over the network using the StageLinQ protocol and provides an elegant, responsive interface to monitor your currently playing tracks, BPM, waveform progress, playback speed, and sync status.

## Features

- **Real-Time Track Info:** Displays Artwork, Track Title, Artist, and Time Remaining.
- **Deck Synchronization:** Multi-deck support (up to 4 decks). Active deck highlighting.
- **Mixer Status:** Visualizes Crossfader position and Channel assignments.
- **Performance Details:** Tracks BPM, Pitch % offset, Sync Mode, Master Deck status, and Hotcue pads.
- **Connected Devices:** USB and SD card presence detection.
- **Dynamic Theming:** Supports both Dark and Light modes. Fully responsive layout perfectly tailored for horizontal and vertical screens.

## Requirements

- Node.js (v16+ recommended).
- A device running Engine OS (e.g., Denon Prime 4, Prime GO, SC6000) on the same local network.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/Mixboard.git
   ```
2. Navigate to the project folder and install dependencies:
   ```bash
   cd Mixboard
   npm install
   ```

## Usage

1. Start the server:
   ```bash
   npm start
   ```
2. Ensure your computer is connected to the same Wi-Fi or LAN as your Denon DJ hardware.
3. Once a device is discovered, open your browser and navigate to the address shown in your terminal (usually `http://localhost:3000` or your local IP address).
4. The dashboard will automatically update as you play tracks and manipulate the hardware.

## Architecture

- **Backend:** Node.js with `express` to serve the UI and `ws` for WebSocket communication.
- **StageLinQ:** Utilizes a patched version of `stagelinq` for real-time UDP/TCP data extraction from the hardware.
- **Frontend:** Vanilla JS (`app.js`), HTML5, and pure CSS for low-latency DOM updates and beautiful aesthetics. The UI design heavily implements CSS Grids/Flexbox and dynamic SVG progress bar animations.

## License

MIT License. See `LICENSE` for details.