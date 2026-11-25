# The LearnHarness VM on the home Proxmox (docs/self-hosting.md).
#
# The NixOS image only BOOTSTRAPS the VM: every later system change goes
# through `deploy/nixos/rebuild.sh switch --target-host
# root@learnharness.fritz.box`. Hence the ignore_changes
# below — a rebuilt image must never replace the disk (and the data on it).

resource "proxmox_virtual_environment_file" "nixos_image" {
  node_name    = var.node
  datastore_id = "local"
  content_type = "import"

  source_file {
    path      = var.image_path
    file_name = "learnharness-nixos.qcow2"
  }

  lifecycle {
    ignore_changes = [source_file]
  }
}

# VM 104 itself moved to VileEnd/hetzner (tofu/home/vms.tf, resource
# proxmox_virtual_environment_vm.learnharness) on 2026-11-24, together with every other
# guest on the home Proxmox, so one repo owns the whole host (backups, monitoring, the
# home-as-code rules). This block makes the next apply here FORGET the VM — state only;
# `destroy = false` means the VM and its data are untouched. Change the VM's hardware in
# the hetzner repo from now on. The NixOS config still deploys from this repo
# (deploy/nixos/rebuild.sh), and the image file and DNS records below stay here.
removed {
  from = proxmox_virtual_environment_vm.learnharness

  lifecycle {
    destroy = false
  }
}
