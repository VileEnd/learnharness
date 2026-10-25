# The LearnHarness VM on the home Proxmox (docs/self-hosting.md).
#
# The NixOS image only BOOTSTRAPS the VM: every later system change goes
# through `nixos-rebuild switch --flake deploy/nixos#learnharness
# --target-host root@learnharness.fritz.box`. Hence the ignore_changes
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

resource "proxmox_virtual_environment_vm" "learnharness" {
  node_name   = var.node
  vm_id       = var.vm_id
  name        = "learnharness"
  description = "LearnHarness (Docker stack on NixOS). Managed by OpenTofu: deploy/proxmox in VileEnd/learnharness."
  tags        = ["learnharness", "nixos", "opentofu"]

  on_boot         = true
  started         = true
  stop_on_destroy = true
  machine         = "q35"
  bios            = "seabios"

  operating_system {
    type = "l26"
  }

  # The image runs qemu-guest-agent; the provider reads the IP from it.
  agent {
    enabled = true
  }

  cpu {
    cores = 2
    type  = "host"
  }

  memory {
    dedicated = 12288
  }

  disk {
    datastore_id = "local-lvm"
    interface    = "virtio0"
    import_from  = proxmox_virtual_environment_file.nixos_image.id
    size         = 32
    discard      = "on"
    iothread     = true
  }

  network_device {
    bridge = "vmbr0"
    model  = "virtio"
  }

  lifecycle {
    # The VM holds the app data, Keycloak's database and the Caddy CA.
    prevent_destroy = true
    ignore_changes  = [disk[0].import_from]
  }
}
