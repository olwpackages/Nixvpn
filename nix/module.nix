{ lib, config, pkgs, ... }:

with lib;
let
  cfg = config.programs.nixvpn;
in {
  options.programs.nixvpn = {
    enable = mkEnableOption "NixVPN desktop client integration";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The NixVPN package that provides the desktop client.";
    };
  };

  config = mkIf cfg.enable {
    security.polkit.enable = true;
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id == "org.freedesktop.policykit.exec" &&
            (action.lookup("program") == "${cfg.package}/libexec/nixvpn-tun-helper" ||
             action.lookup("program") == "${cfg.package}/libexec/nixvpn-tun-supervisor") &&
            subject.active && subject.local) {
          return polkit.Result.AUTH_ADMIN_KEEP;
        }
      });
    '';
    environment.systemPackages = [ cfg.package ];

  };
}
