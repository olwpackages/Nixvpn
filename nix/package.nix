{ lib, stdenv, electron, sing-box, makeWrapper, fetchurl, iproute2, coreutils }:

let
  remixicon = fetchurl {
    url = "https://registry.npmjs.org/remixicon/-/remixicon-4.9.1.tgz";
    hash = "sha512-36gLSoujkabnCFZFDyP17VNh9piuBA/rsXUb4auSJWLGsHVXtmxLj/EM5FjaEAGnk8oIAj1Azob/DZ2N+90lAQ==";
  };
in

stdenv.mkDerivation {
  pname = "nixvpn";
  version = "0.1.0";
  src = ../.;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/nixvpn $out/bin
    cp -r src assets package.json $out/share/nixvpn/
    mkdir -p $out/libexec
    cp nix/nixvpn-tun-helper.sh $out/libexec/nixvpn-tun-helper
    cp nix/nixvpn-tun-supervisor.sh $out/libexec/nixvpn-tun-supervisor
    substituteInPlace $out/libexec/nixvpn-tun-helper \
      --replace-fail '@ipBinary@' '${iproute2}/bin/ip' \
      --replace-fail '@statBinary@' '${coreutils}/bin/stat' \
      --replace-fail '@sleepBinary@' '${coreutils}/bin/sleep' \
      --replace-fail '@trBinary@' '${coreutils}/bin/tr'
    substituteInPlace $out/libexec/nixvpn-tun-supervisor \
      --replace-fail '@singBox@' '${sing-box}/bin/sing-box' \
      --replace-fail '@ipBinary@' '${iproute2}/bin/ip' \
      --replace-fail '@statBinary@' '${coreutils}/bin/stat'
    chmod 755 $out/libexec/nixvpn-tun-helper
    chmod 755 $out/libexec/nixvpn-tun-supervisor
    mkdir -p $out/share/nixvpn/node_modules
    tar -xzf ${remixicon} -C $out/share/nixvpn/node_modules
    mv $out/share/nixvpn/node_modules/package $out/share/nixvpn/node_modules/remixicon
    mkdir -p $out/share/applications $out/share/icons/hicolor/scalable/apps
    cp nix/nixvpn.desktop $out/share/applications/nixvpn.desktop
    cp assets/nixvpn.svg $out/share/icons/hicolor/scalable/apps/nixvpn.svg
    makeWrapper ${electron}/bin/electron $out/bin/nixvpn \
      --add-flags $out/share/nixvpn \
      --set NIXVPN_SING_BOX ${sing-box}/bin/sing-box \
      --set NIXVPN_TUN_HELPER $out/libexec/nixvpn-tun-helper \
      --set NIXVPN_TUN_SUPERVISOR $out/libexec/nixvpn-tun-supervisor
    runHook postInstall
  '';

  meta = {
    description = "Electron VPN subscription client for NixOS";
    platforms = lib.platforms.linux;
    mainProgram = "nixvpn";
  };
}
