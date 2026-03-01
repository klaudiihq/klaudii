import SwiftUI
import AVFoundation

struct PairingView: View {
    let server: Server
    @ObservedObject var appVM: AppViewModel
    @StateObject private var viewModel: PairingViewModel

    init(server: Server, appVM: AppViewModel) {
        self.server = server
        self.appVM = appVM
        self._viewModel = StateObject(wrappedValue: PairingViewModel(
            server: server,
            onPaired: { _ in }  // Will be set properly via onChange
        ))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                KTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 24) {
                        // Header
                        VStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 40))
                                .foregroundColor(KTheme.accent)

                            Text("Pair with \(server.name)")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundColor(KTheme.textWhite)

                            Text("Scan the QR code or paste the konnection key from your local Klaudii's Kloud Konnect panel")
                                .font(.system(size: 13))
                                .foregroundColor(KTheme.textSecondary)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.top, 24)

                        // QR Scanner
                        QRScannerSection(onCodeScanned: { code in
                            viewModel.handleQRCode(code)
                        })

                        // Divider
                        HStack {
                            Rectangle()
                                .fill(KTheme.border)
                                .frame(height: 1)
                            Text("or")
                                .font(.system(size: 12))
                                .foregroundColor(KTheme.textTertiary)
                            Rectangle()
                                .fill(KTheme.border)
                                .frame(height: 1)
                        }
                        .padding(.horizontal)

                        // Manual entry
                        VStack(alignment: .leading, spacing: 8) {
                            Text("CONNECTION KEY")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(KTheme.textSecondary)
                                .tracking(0.5)

                            TextField("Paste connection key...", text: $viewModel.manualKey)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundColor(KTheme.warning)
                                .padding(12)
                                .background(KTheme.cardBackgroundDeep)
                                .cornerRadius(8)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(KTheme.borderHover, lineWidth: 1)
                                )
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)

                            Button {
                                viewModel.submitManualKey()
                            } label: {
                                Text("Save Key")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(KTheme.accent)
                                    .cornerRadius(8)
                            }
                        }
                        .padding(.horizontal)

                        if let error = viewModel.errorMessage {
                            Text(error)
                                .font(.system(size: 12))
                                .foregroundColor(KTheme.danger)
                                .padding(.horizontal)
                        }

                        if viewModel.isPaired {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(KTheme.success)
                                Text("Connected!")
                                    .foregroundColor(KTheme.success)
                            }
                            .font(.system(size: 14, weight: .medium))
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(KTheme.successBg)
                            .cornerRadius(8)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(KTheme.success.opacity(0.3), lineWidth: 1)
                            )
                            .padding(.horizontal)
                        }
                    }
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Pair Browser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(KTheme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Back") {
                        appVM.screen = .serverPicker
                    }
                    .foregroundColor(KTheme.accent)
                }
            }
            .onChange(of: viewModel.isPaired) { _, isPaired in
                if isPaired, let keyHex = CryptoService.connectionKeyFromHex(
                    viewModel.manualKey.replacingOccurrences(of: "-", with: "")
                        .replacingOccurrences(of: " ", with: "")
                ) {
                    appVM.connectToServer(server, connectionKey: keyHex)
                }
            }
        }
    }
}

// MARK: - QR Scanner

struct QRScannerSection: View {
    let onCodeScanned: (String) -> Void
    @State private var isShowingScanner = false

    var body: some View {
        VStack(spacing: 12) {
            if isShowingScanner {
                QRScannerView(onCodeScanned: { code in
                    isShowingScanner = false
                    onCodeScanned(code)
                })
                .frame(height: 250)
                .cornerRadius(12)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(KTheme.success.opacity(0.3), lineWidth: 2)
                )
                .padding(.horizontal)
            } else {
                Button {
                    isShowingScanner = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "camera.fill")
                        Text("Scan QR Code")
                    }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(KTheme.accent)
                    .cornerRadius(8)
                }
                .padding(.horizontal)
            }
        }
    }
}

// MARK: - QR Scanner UIKit Bridge

struct QRScannerView: UIViewControllerRepresentable {
    let onCodeScanned: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onCodeScanned = onCodeScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCodeScanned: ((String) -> Void)?
    private var captureSession: AVCaptureSession?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }

        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = view.layer.bounds
        view.layer.addSublayer(previewLayer)

        captureSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let layer = view.layer.sublayers?.first as? AVCaptureVideoPreviewLayer {
            layer.frame = view.layer.bounds
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        captureSession?.stopRunning()
        onCodeScanned?(value)
    }
}
